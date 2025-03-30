package com.nparashuram.dicomviewer.ui.components

import android.content.Context
import androidx.compose.material3.Slider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalContext
import com.nparashuram.dicomviewer.data.Plane

@Composable
fun ImageSliceSelector(
    plane: Plane, index: Int, max: Int, onUpdate: (Plane, Int, Context) -> Unit,
) {
    val context = LocalContext.current
    LaunchedEffect(Unit) {
        onUpdate(plane, max / 2, context)
    }

    Slider(
        value = index.toFloat(),
        onValueChange = { onUpdate(plane, it.toInt(), context) },
        valueRange = 0f..(max - 1).toFloat()
    )
}
