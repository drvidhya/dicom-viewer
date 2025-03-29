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
import androidx.compose.ui.unit.dp
import com.nparashuram.dicomviewer.PDicomViewModel
import com.nparashuram.dicomviewer.Plane

@Composable
fun ImageSliceSelector(plane: Plane, viewModel: PDicomViewModel) {
    val selectedSlice = viewModel.selectedSlice.collectAsState().value
    val slices = viewModel.selectedPDicom.collectAsState().value?.getSlice(plane)

    if (slices != null) {
        val max: Int = slices.size - 1
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(20.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(plane.name)
            Slider(
                value = (selectedSlice[plane] ?: 0).toFloat(),
                onValueChange = { viewModel.updateSelectedSlice(plane, it.toInt()) },
                valueRange = 0f..max.toFloat()
            )
        }
    } else {
        Text("Did not find any slices in $plane")
    }
}
