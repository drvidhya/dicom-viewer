package com.nparashuram.dicomviewer.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nparashuram.dicomviewer.PDicomViewModel
import com.nparashuram.dicomviewer.Plane
import com.nparashuram.dicomviewer.StatusCode
import com.nparashuram.dicomviewer.ui.components.ImageSlice
import com.nparashuram.dicomviewer.ui.components.ImageSliceSelector

@Composable
fun ViewerScreen(location: String, viewModel: PDicomViewModel, onClose: () -> Unit) {
    val selectedPDicom = viewModel.selectedPDicom.collectAsState().value
    val selectedSlice = viewModel.selectedSlice.collectAsState().value

    var statusCode: StatusCode? by remember { mutableStateOf(StatusCode.NONE) }
    var statusMessage: String? by remember { mutableStateOf(null) }

    LaunchedEffect(location) {
        viewModel.selectPDicom(location) { code, msg ->
            statusCode = code
            statusMessage = msg
        }
    }

    if (selectedPDicom == null) {
        Column {
            Text("Dicom loading ...")
            Text("Status: [${statusCode}]")
            statusMessage?.let { Text(it) }
            Button(onClick = { onClose() }) { Text("Cancel") }
        }
    } else {
        Column {
            Row(
                modifier = Modifier
                    .align(Alignment.CenterHorizontally),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("Viewer Screen", fontSize = 20.sp, modifier = Modifier.padding(5.dp))
                OutlinedButton(onClick = { onClose() }) { Text(text = "x") }
            }
            Text("Location: $location")

            Plane.entries.map { plane ->
                ImageSliceSelector(plane, viewModel)
            }

            Plane.entries.map { plane ->
                selectedSlice[plane]?.let { ImageSlice(plane, selectedPDicom.getSlice(plane), it) }
            }
        }
    }
}
