package com.nparashuram.dicomviewer.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nparashuram.dicomviewer.PDicomViewModel
import com.nparashuram.dicomviewer.Plane

@Composable
fun ImageSlice(plane: Plane, viewModel: PDicomViewModel) {
    val slices = viewModel.selectedPDicom.collectAsState().value?.getSlice(plane)
    val selectedIndex = viewModel.selectedSliceIndex.collectAsState().value[plane]
    val bitmap = viewModel.selectedSliceImg.collectAsState().value[plane]

    if (slices != null && selectedIndex != null && bitmap != null) {
        Image(
            bitmap = bitmap,
            contentDescription = "Image - ${plane}/${slices[selectedIndex]}"
        )
    }
}
