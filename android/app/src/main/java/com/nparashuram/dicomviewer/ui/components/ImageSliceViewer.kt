package com.nparashuram.dicomviewer.ui.components

import androidx.compose.foundation.Image
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.ImageBitmap
import com.nparashuram.dicomviewer.data.Plane

@Composable
fun ImageSlice(plane: Plane, bitmap: ImageBitmap?) {
    if (bitmap != null) {
        Image(
            bitmap = bitmap,
            contentDescription = "Image - ${plane}}"
        )
    }
}
