const BASE_URL = "https://api.immersal.com/"
const CAPTURE_IMAGE = "capture"
const SERVER_LOCALIZE = "localize"
const DOWNLOAD_SPARSE = "sparse";
const DOWNLOAD_DENSE  = "dense";
const TOKEN = "XYZ" // ADD YOUR IMMERSAL DEVELOPER TOKEN
const MAP_IDS = [
  { id: 67628 },  // ADD YOUR IMMERSAL MAP ID
]

let videoWidth = null
let videoHeight = null
let pixelBuffer = null
let cameraIntrinsics = null
let cameraPosition = null
let cameraRotation = null
let isLocalizing = false
let pointCloud = null


// Copyright (c) 2021 8th Wall, Inc.

// Returns a pipeline module that initializes the threejs scene when the camera feed starts, and
// handles subsequent spawning of a glb model whenever the scene is tapped.

/* globals XR8 XRExtras THREE TWEEN */
const placegroundScenePipelineModule = () => {
  const modelFile = 'tree.glb'                            // 3D model to spawn at tap
  const startScale = new THREE.Vector3(0.01, 0.01, 0.01)  // Initial scale value for our model
  const endScale = new THREE.Vector3(2, 2, 2)             // Ending scale value for our model
  const animationMillis = 750                             // Animate over 0.75 seconds

  const raycaster = new THREE.Raycaster()
  const tapPosition = new THREE.Vector2()
  const loader = new THREE.GLTFLoader()  // This comes from GLTFLoader.js.

  let surface  // Transparent surface for raycasting for object placement.

  // Populates some object into an XR scene and sets the initial camera position. The scene and
  // camera come from xr3js, and are only available in the camera loop lifecycle onStart() or later.
  const initXrScene = ({scene, camera, renderer}) => {
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap

    const light = new THREE.DirectionalLight(0xffffff, 1, 100)
    light.position.set(1, 4.3, 2.5)  // default

    scene.add(light)  // Add soft white light to the scene.
    scene.add(new THREE.AmbientLight(0x404040, 5))  // Add soft white light to the scene.

    light.shadow.mapSize.width = 1024  // default
    light.shadow.mapSize.height = 1024  // default
    light.shadow.camera.near = 0.5  // default
    light.shadow.camera.far = 500  // default
    light.castShadow = true

    surface = new THREE.Mesh(
      new THREE.PlaneGeometry(100, 100, 1, 1),
      new THREE.ShadowMaterial({
        opacity: 0.5,
      })
    )

    surface.rotateX(-Math.PI / 2)
    surface.position.set(0, 0, 0)
    surface.receiveShadow = true
    scene.add(surface)

    loadPLY(MAP_IDS[0].id)

    // Set the initial camera position relative to the scene we just laid out. This must be at a
    // height greater than y=0.
    camera.position.set(0, 1, 0)
  }

  const animateIn = (model, pointX, pointZ, yDegrees) => {
    const scale = {...startScale}

    model.scene.rotation.set(0.0, yDegrees, 0.0)
    model.scene.position.set(pointX, 0.0, pointZ)
    model.scene.scale.set(scale.x, scale.y, scale.z)
    model.scene.children[0].children[0].children[0].castShadow = true
    XR8.Threejs.xrScene().scene.add(model.scene)

    new TWEEN.Tween(scale)
      .to(endScale, animationMillis)
      .easing(TWEEN.Easing.Elastic.Out)  // Use an easing function to make the animation smooth.
      .onUpdate(() => {
        model.scene.scale.set(scale.x, scale.y, scale.z)
      })
      .start()  // Start the tween immediately.
  }

  // Load the glb model at the requested point on the surface.
  const placeObject = (pointX, pointZ) => {
    loader.load(
      modelFile,  // resource URL.
      (gltf) => {
        animateIn(gltf, pointX, pointZ, Math.random() * 360)
      }
    )
  }

  const placeObjectTouchHandler = (e) => {
    // Call XrController.recenter() when the canvas is tapped with two fingers. This resets the
    // AR camera to the position specified by XrController.updateCameraProjectionMatrix() above.
    if (e.touches.length === 2) {
      XR8.XrController.recenter()
    }

    if (e.touches.length > 2) {
      return
    }

    // If the canvas is tapped with one finger and hits the "surface", spawn an object.
    const {camera} = XR8.Threejs.xrScene()

    // calculate tap position in normalized device coordinates (-1 to +1) for both components.
    tapPosition.x = (e.touches[0].clientX / window.innerWidth) * 2 - 1
    tapPosition.y = -(e.touches[0].clientY / window.innerHeight) * 2 + 1

    // Update the picking ray with the camera and tap position.
    raycaster.setFromCamera(tapPosition, camera)

    // Raycast against the "surface" object.
    const intersects = raycaster.intersectObject(surface)

    if (intersects.length === 1 && intersects[0].object === surface) {
      placeObject(intersects[0].point.x, intersects[0].point.z)
    }
  }

  return {
    // Pipeline modules need a name. It can be whatever you want but must be unique within your app.
    name: 'placeground',

    // onStart is called once when the camera feed begins. In this case, we need to wait for the
    // XR8.Threejs scene to be ready before we can access it to add content. It was created in
    // XR8.Threejs.pipelineModule()'s onStart method.
    onStart: ({canvas}) => {
      const {scene, camera, renderer} = XR8.Threejs.xrScene()  // Get the 3js sceen from xr3js.

      // Add objects to the scene and set starting camera position.
      initXrScene({scene, camera, renderer})

      canvas.addEventListener('touchstart', placeObjectTouchHandler, true)  // Add touch listener.

      // prevent scroll/pinch gestures on canvas
      canvas.addEventListener('touchmove', (event) => {
        event.preventDefault()
      })

      // Enable TWEEN animations.
      const animate = (time) => {
        requestAnimationFrame(animate)
        TWEEN.update(time)
      }

      animate()

      // Sync the xr controller's 6DoF position and camera paremeters with our scene.
      XR8.XrController.updateCameraProjectionMatrix({
        origin: camera.position,
        facing: camera.quaternion,
      })
    },
  }
}

// Copyright (c) 2023 Immersal - Part of Hexagon

// Returns a pipeline module that can be used with Immersal's VPS.
// Note: requires CameraPixelArray pipeline module to work.
const immersalPipelineModule = () => {
  return {
    name: 'immersal',
    onProcessCpu: ({ frameStartResult, processGpuResult }) => {
      const { camerapixelarray } = processGpuResult
      if (!camerapixelarray || !camerapixelarray.pixels) {
        return
      }
      const { rows, cols, rowBytes, pixels } = camerapixelarray
      return { rows, cols, rowBytes, pixels }
    },
    onUpdate: ({ frameStartResult, processGpuResult, processCpuResult }) => {
      if (!processCpuResult.reality) {
        return
      }
      const { rotation, position, intrinsics } = processCpuResult.reality
      const { textureWidth, textureHeight } = frameStartResult
      const { rows, cols, rowBytes, pixels } = processCpuResult.immersal

      const fy = 0.5 * intrinsics[5] * textureHeight
      const cx = 0.5 * (intrinsics[8] + 1.0) * textureWidth
      const cy = 0.5 * (intrinsics[9] + 1.0) * textureHeight

      const intr = { fx: fy, fy: fy, ox: cx, oy: cy }

      videoWidth = cols
      videoHeight = rows
      pixelBuffer = pixels
      cameraIntrinsics = intr
      cameraPosition = position
      cameraRotation = rotation
    }
  }
}

const onxrloaded = () => {
  XR8.XrController.configure({scale: 'absolute'})

  XR8.addCameraPipelineModules([  // Add camera pipeline modules.
    // Existing pipeline modules.
    XR8.GlTextureRenderer.pipelineModule(),      // Draws the camera feed.
    XR8.CameraPixelArray.pipelineModule({ luminance: true }),
    XR8.Threejs.pipelineModule(),                // Creates a ThreeJS AR Scene.
    XR8.XrController.pipelineModule(),           // Enables SLAM tracking.
    XRExtras.AlmostThere.pipelineModule(),       // Detects unsupported browsers and gives hints.
    XRExtras.FullWindowCanvas.pipelineModule(),  // Modifies the canvas to fill the window.
    XRExtras.Loading.pipelineModule(),           // Manages the loading screen on startup.
    XRExtras.RuntimeError.pipelineModule(),      // Shows an error image on runtime error.
    // Custom pipeline modules.
    immersalPipelineModule(),                    // Enables Immersal VPS support.
    placegroundScenePipelineModule(),
  ])

  // Open the camera and start running the camera run loop.
  XR8.run({canvas: document.getElementById('camerafeed')})
}

// Show loading screen before the full XR library has been loaded.
const load = () => { XRExtras.Loading.showLoading({onxrloaded}) }
window.onload = () => { window.XRExtras ? load() : window.addEventListener('xrextrasloaded', load) }

function capture() {
  const encodedImage = getImageData()

  const json = { token: TOKEN, run: 0, bank: 0, index: 0, anchor: false, px: cameraPosition.x, py: cameraPosition.y, pz: cameraPosition.z, r00: 0, r01: 0, r02: 0, r10: 0, r11: 0, r12: 0, r20: 0, r21: 0, r22: 0, fx: cameraIntrinsics.fx, fy: cameraIntrinsics.fy, ox: cameraIntrinsics.ox, oy: cameraIntrinsics.oy }
  const payload = new Blob([JSON.stringify(json), '\0', encodedImage])

  $.ajax({
    type: "POST",
    url: BASE_URL + CAPTURE_IMAGE,
    data: payload,
    processData: false,
    dataType: "json",
    error: function(data, status, error)
    {
      alert(JSON.stringify(data.responseJSON))
    },
    success: function(data)
    {
      for (var prop in data)
        alert(prop + ": " + data[prop])
      if (data.success) {
        alert("Captured successfully")
      }
      else {
        alert("Failed to capture")
      }
    }
  })
}

// Localize an image with the Immersal VPS (on-server localizer).
function localize() {
  if (isLocalizing)
    return

  isLocalizing = true

  const {scene, camera, renderer} = XR8.Threejs.xrScene()
  const trackerSpace = camera.matrixWorld.clone()

  const encodedImage = getImageData()

  const json = { token: TOKEN, fx: cameraIntrinsics.fx, fy: cameraIntrinsics.fy, ox: cameraIntrinsics.ox, oy: cameraIntrinsics.oy, param1: 0, param2: 12, param3: 0.0, param4: 2.0, mapIds: MAP_IDS }
  const payload = new Blob([JSON.stringify(json), '\0', encodedImage])

  $.ajax({
    type: "POST",
    url: BASE_URL + SERVER_LOCALIZE,
    data: payload,
    processData: false,
    dataType: "json",
    error: function(data, status, error)
    {
      alert(JSON.stringify(data.responseJSON))
      isLocalizing = false
    },
    success: function(data)
    {
      if (data.success) {
        //alert("Relocalized successfully")
        if (pointCloud) {
          let position = new THREE.Vector3()
          let rotation = new THREE.Quaternion()
          let scale = new THREE.Vector3()

          const cloudSpace = new THREE.Matrix4();
          cloudSpace.set(data.r00, -data.r01, -data.r02, data.px,
            data.r10, -data.r11, -data.r12, data.py,
            data.r20, -data.r21, -data.r22, data.pz,
            0, 0, 0, 1);

          const m = new THREE.Matrix4().multiplyMatrices(trackerSpace, cloudSpace.invert());

          m.decompose(position, rotation, scale);

          pointCloud.position.set(position.x, position.y, position.z);
          pointCloud.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
          pointCloud.scale.set(scale.x, scale.y, scale.z);
        }
      }
      else {
        alert("Failed to relocalize")
      }
      isLocalizing = false
    }
  })
}

// Get the camera pixel buffer as an 8-bit grayscale PNG.
function getImageData() {
  let buffer = UPNG.encodeLL([pixelBuffer], videoWidth, videoHeight, 1, 0, 8, 0)
  return buffer
}

// Load a .ply file from Immersal to visualize localization.
// Switch DOWNLOAD_DENSE to DOWNLOAD_SPARSE if you want to use the sparse point cloud.
function loadPLY(mapId) {
  let loader = new THREE.PLYLoader()
  let url = BASE_URL + DOWNLOAD_DENSE + '?token=' + TOKEN + '&id=' + mapId

  loader.load(url, function (geometry) {
    const {scene, camera, renderer} = XR8.Threejs.xrScene()

    geometry.computeVertexNormals()
    geometry.computeFaceNormals();

    let material = new THREE.PointsMaterial({ color: 0xFFFF00, vertexColors: THREE.VertexColors, size: 5, sizeAttenuation: false } )
    pointCloud = new THREE.Points( geometry, material )

    const box = new THREE.Box3().setFromObject(pointCloud);
    const size = box.getSize(new THREE.Vector3()).length();
    const center = box.getCenter(new THREE.Vector3());

    pointCloud.scale.set(1, 1, 1)
          
    scene.add( pointCloud )

    let axesHelper = new THREE.AxesHelper( 1 );
    axesHelper.position.x -= center.x;
    axesHelper.position.y -= center.y;
    axesHelper.position.z -= center.z;
    scene.add( axesHelper );
  })
}

$(document).ready(function() {
  $('#capturebutton').click(function(e) {
    e.preventDefault();

    capture()
  })

  $('#localizebutton').click(function(e) {
    e.preventDefault();

    localize()
  })
})
