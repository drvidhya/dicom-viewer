package com.nparashuram.dicomviewer.data

import kotlinx.serialization.json.Json
import okhttp3.CacheControl
import okhttp3.OkHttpClient
import okhttp3.Request
import okio.BufferedSource
import java.io.IOException
import java.net.URI
import java.net.URL

class NetworkDownloader(private val okHttpClient: OkHttpClient, private val storage: Storage) {
    fun fetchPDicomFiles(url: String, onStatusUpdate: StatusUpdateFn) {
        fetch(URL(url), onStatusUpdate) { data ->
            val pDicomFiles = Json.decodeFromString(PDicomFiles.serializer(), data.readUtf8())
            downloadFiles(url, pDicomFiles, onStatusUpdate)
        }
    }

    private fun downloadFiles(
        url: String,
        pDicomFiles: PDicomFiles,
        onStatusUpdate: StatusUpdateFn,
    ) {
        val gltfFilename = "model.gltf"
        fetch(URI(url).resolve(pDicomFiles.gltf).toURL(), onStatusUpdate) { data ->
            storage.save(gltfFilename, data)
        }

        val axial =
            downloadPlanes(pDicomFiles.getSlice(Plane.axial), Plane.axial, url, onStatusUpdate)
        val coronal =
            downloadPlanes(pDicomFiles.getSlice(Plane.coronal), Plane.coronal, url, onStatusUpdate)
        val sagittal =
            downloadPlanes(
                pDicomFiles.getSlice(Plane.sagittal),
                Plane.sagittal,
                url,
                onStatusUpdate
            )

        storage.saveIndex(
            PDicomData(
                url,
                storage.location.name,
                PDicomFiles(axial, coronal, sagittal, gltfFilename)
            )
        )
    }

    private fun downloadPlanes(
        files: List<String>,
        plane: Plane,
        url: String,
        onStatusUpdate: StatusUpdateFn,
    ): List<String> {
        return files.mapIndexed { index, slice ->
            val filename = "${plane.name}/${index}.png"
            val location = URI(url).resolve(slice).toURL()
            fetch(location, onStatusUpdate) { data -> storage.save(filename, data) }
            filename
        }
    }

    private fun fetch(url: URL, onStatusUpdate: StatusUpdateFn, onData: (BufferedSource) -> Unit) {
        onStatusUpdate(StatusCode.PROGRESS, "Downloading $url")
        val request = Request.Builder().url(url).cacheControl(CacheControl.FORCE_NETWORK).build()
        val response = okHttpClient.newCall(request).execute()
        if (response.isSuccessful) {
            val data = response.body?.source()
            if (data == null) {
                response.close()
                throw IOException("Error fetching ${url}, Data is null")
            }
            onStatusUpdate(StatusCode.PROGRESS, "Download complete - $url")
            onData(data)
        } else {
            response.close()
            throw IOException("Error fetching ${url}, response is ${response.code}")
        }
    }
}
