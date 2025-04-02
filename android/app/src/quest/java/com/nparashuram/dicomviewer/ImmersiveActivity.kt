package com.nparashuram.dicomviewer

import android.net.Uri
import android.os.Bundle
import android.os.PersistableBundle
import com.meta.spatial.castinputforward.CastInputForwardFeature
import com.meta.spatial.compose.ComposeFeature
import com.meta.spatial.compose.composePanel
import com.meta.spatial.core.BuildConfig
import com.meta.spatial.core.Entity
import com.meta.spatial.core.Pose
import com.meta.spatial.core.Quaternion
import com.meta.spatial.core.SpatialFeature
import com.meta.spatial.core.Vector3
import com.meta.spatial.runtime.ReferenceSpace
import com.meta.spatial.toolkit.AppSystemActivity
import com.meta.spatial.toolkit.Grabbable
import com.meta.spatial.toolkit.Material
import com.meta.spatial.toolkit.Mesh
import com.meta.spatial.toolkit.PanelRegistration
import com.meta.spatial.toolkit.SupportsLocomotion
import com.meta.spatial.toolkit.Transform
import com.meta.spatial.toolkit.createPanelEntity
import com.meta.spatial.vr.LocomotionSystem
import com.meta.spatial.vr.VRFeature
import com.nparashuram.dicomviewer.data.PDicomRepo

class ImmersiveActivity : AppSystemActivity() {
    override fun registerFeatures(): List<SpatialFeature> {
        val features = mutableListOf<SpatialFeature>(VRFeature(this))
        if (BuildConfig.DEBUG) {
            features.add(CastInputForwardFeature(this))
        }
        features.add(ComposeFeature())
        return features
    }

    override fun onCreate(savedInstanceState: Bundle?, persistentState: PersistableBundle?) {
        super.onCreate(savedInstanceState, persistentState)
        val locomotionSystem = systemManager.findSystem<LocomotionSystem>()
        locomotionSystem.enableLocomotion(true)
    }

    override fun onSceneReady() {
        super.onSceneReady()

        scene.setReferenceSpace(ReferenceSpace.LOCAL_FLOOR)

        scene.setLightingEnvironment(
            ambientColor = Vector3(0f),
            sunColor = Vector3(7.0f, 7.0f, 7.0f),
            sunDirection = -Vector3(1.0f, 3.0f, -2.0f),
            environmentIntensity = 0.3f
        )
        scene.enableHolePunching(true)

        scene.setViewOrigin(0.0f, 0.0f, 0.0f)

        Entity.create(
            listOf(
                Mesh(Uri.parse("mesh://skybox")),
                Material().apply {
                    baseTextureAndroidResourceId = R.drawable.skydome
                    unlit = true // Prevent scene lighting from affecting the skybox
                },
                Transform(Pose(Vector3(x = 0f, y = 0f, z = 0f)))
            )
        )

        Entity.create(
            listOf(
                Mesh(Uri.parse("environment.glb")),
                SupportsLocomotion(),
                Transform(Pose(Vector3(0f, 0f, 0f)))
            )
        )

        Entity.createPanelEntity(
            100,
            Transform(Pose(Vector3(0f, 1.0f,  2f), Quaternion(0f, 180f, 0f))),
            Grabbable(),
        )
        val context = this
        val location = intent.getStringExtra("location")
        registerPanel(PanelRegistration(100) {
            composePanel {
                setContent {
                    DicomApp(PDicomRepo.getInstance(context))
                }
            }
        })
    }

}
