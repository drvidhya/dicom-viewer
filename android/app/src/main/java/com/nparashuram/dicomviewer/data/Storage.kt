package com.nparashuram.dicomviewer.data

import kotlinx.serialization.json.Json
import okio.BufferedSource
import okio.buffer
import okio.sink
import java.io.File

class Storage internal constructor(val location: File) {
    fun save(filename: String, data: BufferedSource) {
        val file = getFileFromFilename(filename)
        val sink = file.sink().buffer()
        sink.writeAll(data)
        sink.close()
    }

    fun remove(): Boolean {
        return location.deleteRecursively()
    }

    fun getIndex(): PDicomData? {
        try {
            val file = File(location, "index.json")
            val text = file.readText()
            return Json.decodeFromString<PDicomData>(text)
        } catch (e: Exception) {
            return null
        }
    }

    fun saveIndex(pDicomData: PDicomData) {
        val file = File(location, "index.json")
        val text = Json.encodeToString(PDicomData.serializer(), pDicomData)
        file.writeText(text)
    }

    fun getImageFile(file: String): File {
        return File(location, file)
    }

    private fun getFileFromFilename(filename: String): File {
        val file = File(location, filename)
        val parentFolder = file.parentFile
        if (parentFolder != null && !parentFolder.exists()) {
            parentFolder.mkdirs()
        }
        return file
    }
}

class StorageFactory(private val storageDir: File) {
    fun get(folder: String): Storage {
        val file = File(File(storageDir, "processed-dicom"), folder)
        return Storage(file)
    }

    fun getStorages(): List<Storage> {
        val folder = File(storageDir, "processed-dicom")
        if (folder.isDirectory) {
            val folders = folder.listFiles { file -> file.isDirectory }
            return folders?.map { file -> Storage(file) } ?: emptyList()
        } else {
            return emptyList()
        }
    }
}
