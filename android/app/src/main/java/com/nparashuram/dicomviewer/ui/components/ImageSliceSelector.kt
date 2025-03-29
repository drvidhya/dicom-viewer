package com.nparashuram.dicomviewer.ui.components

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.nparashuram.dicomviewer.PDicomViewModel
import com.nparashuram.dicomviewer.Plane

@Composable
fun ImageSliceSelector(plane: Plane, viewModel: PDicomViewModel) {
    val selectedSliceIndex = viewModel.selectedSliceIndex.collectAsState().value
    val slices = viewModel.selectedPDicom.collectAsState().value?.getSlice(plane)
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
