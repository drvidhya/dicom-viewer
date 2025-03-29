package com.nparashuram.dicomviewer.ui.components

import androidx.compose.foundation.Image
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import com.nparashuram.dicomviewer.data.PDicomViewModel
import com.nparashuram.dicomviewer.data.Plane

@Composable
fun ImageSlice(plane: Plane, viewModel: PDicomViewModel) {
    val slices = viewModel.selectedPDicom.collectAsState().value?.files?.getSlice(plane)
    val selectedIndex = viewModel.selectedSliceIndex.collectAsState().value[plane]
    val bitmap = viewModel.selectedSliceImg.collectAsState().value[plane]

    if (slices != null && selectedIndex != null && bitmap != null) {
        Image(
            bitmap = bitmap,
            contentDescription = "Image - ${plane}/${slices[selectedIndex]}"
        )
    }
}
