package com.nparashuram.dicomviewer.ui.components

import androidx.compose.foundation.Image
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.viewModelScope
import com.nparashuram.dicomviewer.data.PDicomViewModel
import com.nparashuram.dicomviewer.data.Plane
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

@Composable
fun ImageSlice(plane: Plane, viewModel: PDicomViewModel) {
    val selectedSliceIndex = viewModel.selectedSliceIndex.collectAsState().value

    var bitmap: ImageBitmap? by remember { mutableStateOf(null) }

    val index = selectedSliceIndex[plane]
    val context = LocalContext.current

    LaunchedEffect(index) {
        viewModel.viewModelScope.launch(Dispatchers.IO) {
            bitmap = viewModel.loadImage(plane, context)
        }
    }

    val bmp = bitmap
    if (bmp != null) {
        Image(
            bitmap = bmp,
            contentDescription = "Image - ${plane}}"
        )
    }
}
