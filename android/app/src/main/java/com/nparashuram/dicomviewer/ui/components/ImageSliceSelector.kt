package com.nparashuram.dicomviewer.ui.components

import androidx.compose.material3.Slider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.platform.LocalContext
import com.nparashuram.dicomviewer.data.PDicomViewModel
import com.nparashuram.dicomviewer.data.Plane

@Composable
fun ImageSliceSelector(plane: Plane, viewModel: PDicomViewModel) {
    val selectedSliceIndex = viewModel.selectedSliceIndex.collectAsState().value
    val slices = viewModel.selectedPDicom.collectAsState().value?.files?.getSlice(plane)
    val context = LocalContext.current

    if (slices != null) {
        val max: Int = slices.size - 1
        Slider(
            value = (selectedSliceIndex[plane] ?: 0).toFloat(),
            onValueChange = { viewModel.updateSelectedSlice(plane, it.toInt(), context) },
            valueRange = 0f..max.toFloat()
        )
    }
}
