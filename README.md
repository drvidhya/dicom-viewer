# Dicom Viewer for Android

# Python

Takes a dicom file and converts it to a set of PNGs, GLTF model and a JSON index file which is used by the app
Steps to run inside `./python` folder

Requires Python 3.12 (for Open3D compat)

1. Create a python virtual env using `python3.12 -m venv .venv` if not already created
2. Install dependencies using `pip install -r requirements.txt`
3. Activate the virtual environment using `source ./.venv/bin/activate`
4. Run `python dicom_to_png.py` to process dicom images
