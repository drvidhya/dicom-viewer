package com.nparashuram.dicomviewer

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.nparashuram.dicomviewer.data.PDicomRepo

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            DicomApp(PDicomRepo.getInstance(this))
        }
    }
}
