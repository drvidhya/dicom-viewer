import SimpleITK as sitk
import sys
import os
import numpy as np
import trimesh
import open3d as o3d

from skimage import measure

def progress_bar(iteration, total, prefix='', suffix='', length=30, fill='█'):
    percent = ("{0:.1f}").format(100 * (iteration / float(total)))
    filled_length = int(length * iteration // total)
    bar = fill * filled_length + '-' * (length - filled_length)
    sys.stdout.write(f'\r{prefix} |{bar}| {percent}% {suffix}')
    sys.stdout.flush()

def createSlices(input_image, useAdaptiveHistogram=False):
    result_slices = []
    count = input_image.GetDepth()
    for i in range(0, count):
        progress_bar(i, count, prefix='Create Slices:', suffix=' ', length=50)
        slice = input_image[:, :, i]
        if useAdaptiveHistogram:
            slice = sitk.AdaptiveHistogramEqualization(slice, slice.GetSize())
        result_slices.append(slice)
    return result_slices

def writeSlices(slices, out_dir, name):
    out_dir = os.path.join(out_dir, name)
    if not os.path.exists(out_dir):
        os.makedirs(out_dir)

    # Iterate over each slice and save as PNG
    for i in range(len(slices)):
        progress_bar(i, len(slices)-1, prefix='Write :' + out_dir, suffix='', length=50)

        # Extract the slice
        slice_image = slices[i]

        # Convert the slice to a format suitable for PNG
        slice_image = sitk.RescaleIntensity(slice_image, 0, 255)  # Rescale to 0-255
        slice_image = sitk.Cast(slice_image, sitk.sitkUInt8)
       
        # Write the PNG image
        png_filename = os.path.join(out_dir, f'slice_{i:03d}.png')
        sitk.WriteImage(slice_image, png_filename)

# Read Images
def read_images(input_data_directory): 
    series_IDs = sitk.ImageSeriesReader.GetGDCMSeriesIDs(input_data_directory)
    if not series_IDs:
        print(
            'ERROR: given directory "'
            + input_data_directory
            + '" does not contain a DICOM series.'
        )
        sys.exit(1)

    series_file_names = sitk.ImageSeriesReader.GetGDCMSeriesFileNames(
        input_data_directory, series_IDs[0]
    )

    series_reader = sitk.ImageSeriesReader()
    series_reader.SetFileNames(series_file_names)
    series_reader.MetaDataDictionaryArrayUpdateOn()
    series_reader.LoadPrivateTagsOn()
    image = series_reader.Execute()
    return image


def getPlanes(image):
# Convert to specific plans
    sagittal_image = sitk.PermuteAxes(image, [2, 0, 1])
    sagittal_image = sitk.Flip(sagittal_image, [False, False, True])
    coronal_image = sitk.PermuteAxes(image, [0, 2, 1])
    coronal_image = sitk.Flip(coronal_image, [False, False, True])
    axial_image = image
    return {
            "axial": axial_image, 
            "coronal": coronal_image, 
            "saggital": sagittal_image
            }


def createGltf(image, out_dir, lower_threshold = 500,  upper_threshold = 1000):
     # -300 Soft tissue threshold for CT, 500 for bone. 1000 upper for bone density 
    array = sitk.GetArrayFromImage(image)

    binary_mask = np.logical_and(array > lower_threshold, array < upper_threshold)
    verts, faces, _, _ = measure.marching_cubes(binary_mask, level=0.5)
    mesh = trimesh.Trimesh(vertices=verts, faces=faces)

    o3d_mesh = o3d.geometry.TriangleMesh()
    o3d_mesh.vertices = o3d.utility.Vector3dVector(mesh.vertices)
    o3d_mesh.triangles = o3d.utility.Vector3iVector(mesh.faces)
    o3d_mesh = o3d_mesh.filter_smooth_laplacian(number_of_iterations=10)
    o3d_mesh = o3d_mesh.filter_smooth_taubin(number_of_iterations=10)

    if not os.path.exists(out_dir):
        os.makedirs(out_dir)
    o3d.io.write_triangle_mesh(os.path.join(out_dir, "model.gltf"), o3d_mesh)

def main():
    if not len(sys.argv) == 3: 
        print(f"Usage : {sys.argv[0]} input_folder output_folder {len(sys.argv)}")
        sys.exit(1)
    
    input_dir = sys.argv[1]
    out_dir = sys.argv[2]

    images = read_images(input_dir)
    planes = getPlanes(images)
    writeSlices(createSlices(planes["axial"], True), out_dir, "axial")
    writeSlices(createSlices(planes["coronal"], True), out_dir, "coronal")
    writeSlices(createSlices(planes["saggital"], True), out_dir , "saggital")
    createGltf(images, out_dir)

if __name__ == "__main__":
    main()

