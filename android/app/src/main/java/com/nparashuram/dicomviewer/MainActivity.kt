package com.nparashuram.dicomviewer

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import coil.ImageLoader
import coil.request.CachePolicy
import com.nparashuram.dicomviewer.data.PDicomRepo
import com.nparashuram.dicomviewer.data.StorageFactory
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val okHttpClient = OkHttpClient.Builder()
            .addInterceptor(HttpLoggingInterceptor().apply { setLevel(HttpLoggingInterceptor.Level.BASIC) })
            .build()

        val imageLoader = ImageLoader.Builder(this)
            .okHttpClient(okHttpClient)
            .memoryCachePolicy(CachePolicy.ENABLED)
            .diskCachePolicy(CachePolicy.DISABLED)
            .build()

        val pDicomRepo = PDicomRepo(
            storageFactory = StorageFactory(filesDir),
            okHttpClient = okHttpClient,
            imageLoader = imageLoader
        )

        setContent {
            DicomApp(pDicomRepo)
        }
    }
}
