import SimpleITK as sitk
import sys
import os
import numpy as np
import trimesh
import open3d as o3d
import json

from skimage import measure

def makeDirIfNotExists(*path): 
    dir = os.path.join(*path)
    if not os.path.exists(dir):
        os.makedirs(dir)
    return dir

class ProgressBar: 
    def __init__(self, total, prefix='', suffix = '', length=30, fill='█'):
        self.total = total
        self.prefix = prefix
        self.suffix = suffix
        self.length = length
        self.fill = fill
        self.iteration = 0
        self.render()

    def render(self):
        percent = ("{0:.1f}").format(100 * (self.iteration / float(self.total)))
        filled_length = int(self.length * self.iteration // self.total)
        bar = self.fill * filled_length + '-' * (self.length - filled_length)
        sys.stdout.write(f'\r{self.prefix} |{bar}| {percent}% {self.suffix} \033[K')
        sys.stdout.flush()
    
    def val(self, val):
        self.iteration = val
        self.render()
        
    
    

def createSlices(input_image, useAdaptiveHistogram=False):
    result_slices = []
    count = input_image.GetDepth()
    progress_bar = ProgressBar(count, prefix='Create Slices:')
    for i in range(0, count):
        progress_bar.val(i)
        slice = input_image[:, :, i]
        if useAdaptiveHistogram:
            slice = sitk.AdaptiveHistogramEqualization(slice, slice.GetSize())
        result_slices.append(slice)
    return result_slices

def writeSlices(slices, out_dir, name): 
    makeDirIfNotExists(out_dir, name)

    filenames = []
    progress_bar = ProgressBar(len(slices)-1, prefix=f'Write : {name}')

    # Iterate over each slice and save as PNG
    for i in range(len(slices)):
        progress_bar.val(i)

        # Extract the slice
        slice_image = slices[i]

        # Convert the slice to a format suitable for PNG
        slice_image = sitk.RescaleIntensity(slice_image, 0, 255)  # Rescale to 0-255
        slice_image = sitk.Cast(slice_image, sitk.sitkUInt8)
       
        # Write the PNG image
        png_filename = os.path.join(name, f'slice_{i:03d}.png')
        sitk.WriteImage(slice_image, os.path.join(out_dir, png_filename))
        filenames.append(png_filename)
    return filenames

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
    progress_bar = ProgressBar(5, prefix='Generate GLTF')

     # -300 Soft tissue threshold for CT, 500 for bone. 1000 upper for bone density 
    array = sitk.GetArrayFromImage(image)
    binary_mask = np.logical_and(array > lower_threshold, array < upper_threshold)
    verts, faces, _, _ = measure.marching_cubes(binary_mask, level=0.5)
    mesh = trimesh.Trimesh(vertices=verts, faces=faces)
    progress_bar.val(1)

    o3d_mesh = o3d.geometry.TriangleMesh()
    o3d_mesh.vertices = o3d.utility.Vector3dVector(mesh.vertices)
    o3d_mesh.triangles = o3d.utility.Vector3iVector(mesh.faces)

    progress_bar.val(2)
    o3d_mesh = o3d_mesh.filter_smooth_laplacian(number_of_iterations=10)
    
    progress_bar.val(3)
    o3d_mesh = o3d_mesh.filter_smooth_taubin(number_of_iterations=10)
    
    progress_bar.val(4)
    makeDirIfNotExists(out_dir)
    
    filename = "model.gltf"
    o3d.io.write_triangle_mesh(os.path.join(out_dir, filename), o3d_mesh)
    progress_bar.val(5)
    return filename

def main():
    if not len(sys.argv) == 3: 
        print(f"Usage : {sys.argv[0]} input_dicom_folder output_folder {len(sys.argv)}")
        sys.exit(1)
    
    input_dir = sys.argv[1]
    out_dir = sys.argv[2]
    useAdaptiveHistogram = True

    result = {}
    images = read_images(input_dir)
    planes = getPlanes(images)
    result["axial"] = writeSlices(createSlices(planes["axial"], useAdaptiveHistogram), out_dir, "axial")
    result["coronal"] = writeSlices(createSlices(planes["coronal"], useAdaptiveHistogram), out_dir, "coronal")
    result["saggital"] = writeSlices(createSlices(planes["saggital"], useAdaptiveHistogram), out_dir, "saggital")
    result["gltf"] = createGltf(images, out_dir)

    f = open(os.path.join(out_dir,"index.json"), "w")
    f.write(json.dumps(result))
    f.close()

if __name__ == "__main__":
    main()

