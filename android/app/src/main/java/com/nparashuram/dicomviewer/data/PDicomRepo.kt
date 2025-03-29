package com.nparashuram.dicomviewer.data

import android.content.Context
import android.graphics.drawable.ShapeDrawable
import android.util.Log
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.core.graphics.drawable.toBitmap
import coil.ImageLoader
import coil.request.CachePolicy
import coil.request.ImageRequest
import com.nparashuram.dicomviewer.PDicomData
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.CacheControl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.net.URI
import java.net.URL
import kotlin.random.Random

class PDicomRepo(
    private val okHttpClient: OkHttpClient,
    private val storageFactory: StorageFactory,
    private val imageLoader: ImageLoader,
) {

    /**
     * Parses the processed-dicom folder and gets a map of all saved pDiCom
     */
    fun loadFromDevice(onStatusUpdate: (String) -> Unit): Map<String, String?> {
        return storageFactory.getFolders()
            .associate { storage ->
                onStatusUpdate("Reading ${storage.dir}")
                (storage.readIndex().url ?: "") to storage.dir.name
            }.filter { it.key != "" }
    }

    /**
     * Load a specific pDiCom file from disk
     */
    fun load(storageLocation: String): PDicomData {
        val storage = storageFactory.get(storageLocation)
        return storage.readIndex()
    }

    suspend fun loadImage(storageLocation: String, file: String, context: Context): ImageBitmap? {
        val storage = storageFactory.get(storageLocation)
        val src = storage.getImageFile(file)
        val imageRequest = ImageRequest.Builder(context)
            .data(src)
            .memoryCachePolicy(CachePolicy.DISABLED)
            .build()

        val drawable = imageLoader.execute(imageRequest).drawable ?: ShapeDrawable()
        return drawable.toBitmap().asImageBitmap()
    }

    /**
     * Deletes a location
     */
    fun remove(storageLocation: String): Boolean {
        val storage = storageFactory.get(storageLocation)
        return storage.remove()
    }

    /**
     * Downloads the index file, and then each plane and model from network
     */
    fun download(url: String, onStatusUpdate: (String) -> Unit): String {
        val storage = storageFactory.get(getRandomName())
        val downloader = Downloader(storage, okHttpClient, onStatusUpdate)

        downloader.downloadAndSave("index.json", URL(url))
        val pDicomData = storage.readIndex()

        val gltfFilename = "model.gltf"
        downloader.downloadAndSave(gltfFilename, URI(url).resolve(pDicomData.gltf).toURL())

        val axial = savePlaneImages(pDicomData.axial, "axial", url, downloader)
        val coronal = savePlaneImages(pDicomData.coronal, "coronal", url, downloader)
        val sagittal = savePlaneImages(pDicomData.sagittal, "sagittal", url, downloader)

        val data = PDicomData(axial, coronal, sagittal, gltfFilename, url)
        storage.save("index.json", Json.encodeToString<PDicomData>(data))

        return storage.dir.name
    }

    private fun savePlaneImages(
        list: List<String>,
        plane: String,
        url: String,
        downloader: Downloader,
    ): List<String> {
        val result = mutableListOf<String>()
        list.forEachIndexed { index, item ->
            val filename = "${plane}/${index}.png"
            val location = URI(url).resolve(item).toURL()
            downloader.downloadAndSave(filename, location)
            result.add(filename)
        }
        return result
    }
}

private class Downloader(
    private val storage: Storage,
    private val okHttpClient: OkHttpClient,
    private val onStatusUpdate: (String) -> Unit,
) {
    fun downloadAndSave(filename: String, url: URL) {
        Log.i("AXE", "Downloading $url")
        onStatusUpdate("Downloading $url")
        val request = Request.Builder().url(url).cacheControl(CacheControl.FORCE_NETWORK).build()
        val response = okHttpClient.newCall(request).execute()
        if (response.isSuccessful) {
            val data = response.body?.source()
            if (data == null) {
                response.close()
                throw IOException("Error fetching ${url}, Data is null")
            }
            storage.save(filename, data)
            response.close()
            onStatusUpdate("Download complete - $url")
        } else {
            response.close()
            throw IOException("Error fetching ${url}, response is ${response.code}")
        }
    }
}

private fun getRandomName(): String {
    val charPool: List<Char> = ('a'..'z') + ('A'..'Z')
    val folderName = (1..20)
        .map { Random.nextInt(0, charPool.size).let { charPool[it] } }
        .joinToString("")
    return folderName
}
