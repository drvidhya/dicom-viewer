package com.nparashuram.dicomviewer.ui.components

import androidx.compose.material3.Slider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import com.nparashuram.dicomviewer.data.PDicomViewModel
import com.nparashuram.dicomviewer.data.Plane

@Composable
fun ImageSliceSelector(
    plane: Plane, viewModel: PDicomViewModel,
) {
    val selectedPDicom = viewModel.selectedPDicom.collectAsState().value
    val selectedSliceIndex = viewModel.selectedSliceIndex.collectAsState().value

    val max = selectedPDicom?.files?.getSlice(plane)?.size ?: 0

    LaunchedEffect(Unit) {
        viewModel.updateSelectedSlice(plane, 0)
    }

    val index = selectedSliceIndex[plane]
    if (selectedPDicom != null && index != null) {
        Slider(
            value = index.toFloat(),
            onValueChange = { viewModel.updateSelectedSlice(plane, it.toInt()) },
            valueRange = 0f..(max - 1).toFloat()
        )
    }
}
