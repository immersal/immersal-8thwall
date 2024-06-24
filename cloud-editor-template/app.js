// Copyright (c) 2022 8th Wall, Inc.
//
// app.js is the main entry point for your 8th Wall app. Code here will execute after head.html
// is loaded, and before body.html is loaded.

import './index.css'
import {placegroundScenePipelineModule} from './placeground-scene-module.js'
import {immersalPipelineModule} from './immersal-module.js'
import * as camerafeedHtml from './camerafeed.html'

// ADD YOUR IMMERSAL DEVELOPER TOKEN AND MAP IDS
const params = {
  developerToken: 'XYZ',
  mapIds: [123],
  localizationInterval: 1000,  // ms
  showPointCloud: true,
  pointCloudType: 1,  // 0 = sparse, 1 = dense
  showAxes: true,
  useFilter: true,
}

const onxrloaded = () => {
  XR8.XrController.configure({scale: 'absolute'})
//  XR8.XrController.configure({scale: 'responsive'})

  XR8.addCameraPipelineModules([  // Add camera pipeline modules.
    // Existing pipeline modules.
    XR8.GlTextureRenderer.pipelineModule(),      // Draws the camera feed.
    XR8.CameraPixelArray.pipelineModule({luminance: true}),  // Provides the camera texture.
    XR8.Threejs.pipelineModule(),                // Creates a ThreeJS AR Scene.
    XR8.XrController.pipelineModule(),           // Enables SLAM tracking.
    window.LandingPage.pipelineModule(),         // Detects unsupported browsers and gives hints.
    XRExtras.FullWindowCanvas.pipelineModule(),  // Modifies the canvas to fill the window.
    XRExtras.Loading.pipelineModule(),           // Manages the loading screen on startup.
    XRExtras.RuntimeError.pipelineModule(),      // Shows an error image on runtime error.
    // Custom pipeline modules.
    immersalPipelineModule(params),  // Enables Immersal VPS support.
    placegroundScenePipelineModule(),
  ])

  // Open the camera and start running the camera run loop.
  document.body.insertAdjacentHTML('beforeend', camerafeedHtml)
  XR8.run({canvas: document.getElementById('camerafeed')})
}

// Show loading screen before the full XR library has been loaded.
XRExtras.Loading.showLoading({onxrloaded})
