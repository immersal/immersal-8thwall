// Copyright (c) 2024 Immersal - Part of Hexagon

// Returns a pipeline module that can be used with Immersal's VPS.
// Note: requires CameraPixelArray pipeline module to work.

export const immersalPipelineModule = (params) => {
  const BASE_URL = 'https://api.immersal.com/'
  const CAPTURE = 'capture'
  const SERVER_LOCALIZE = 'localize'
  const DOWNLOAD_SPARSE = 'sparse'
  const DOWNLOAD_DENSE = 'dense'

  const {developerToken, mapIds, localizationInterval, showPointCloud, pointCloudType, showAxes, useFilter} = params

  let isLocalizing = false
  let pointCloud = null
  let timer = null
  let prevTime = performance.now()
  let elapsedTime = null

  const cameraData = {
    width: 0,
    height: 0,
    buffer: null,
    intrinsics: {fx: 0, fy: 0, ox: 0, oy: 0},
    position: {x: 0, y: 0, z: 0},
    rotation: {x: 0, y: 0, z: 0, w: 1},
  }

  const warpThresholdDistSq = 5.0 * 5.0
  const warpThresholdCosAngle = Math.cos(20.0 * Math.PI / 180.0)
  const rotX = THREE.Math.degToRad(180)
  const rotY = THREE.Math.degToRad(0)
  const rotZ = THREE.Math.degToRad(0)
  const Qrot = new THREE.Quaternion()
  const eulerRot = new THREE.Euler(rotX, rotY, rotZ, 'XYZ')
  Qrot.setFromEuler(eulerRot)

  class PoseFilter {
    constructor() {
      this.position = new THREE.Vector3()
      this.rotation = new THREE.Quaternion()

      this.mHistorySize = 8
      this.mP = new Array(this.mHistorySize).fill().map(() => new THREE.Vector3())
      this.mX = new Array(this.mHistorySize).fill().map(() => new THREE.Vector3())
      this.mZ = new Array(this.mHistorySize).fill().map(() => new THREE.Vector3())
      this.mSamples = 0
    }

    sampleCount() {
      return this.mSamples
    }

    invalidateHistory() {
      this.mSamples = 0
    }

    resetFiltering() {
      this.position.set(0, 0, 0)
      this.rotation.identity()
      this.invalidateHistory()
    }

    refinePose(R) {
      const idx = this.mSamples % this.mHistorySize
      const els = R.elements
      this.mP[idx].set(els[0 + 3 * 4], els[1 + 3 * 4], els[2 + 3 * 4])
      this.mX[idx].set(els[0 + 0 * 4], els[1 + 0 * 4], els[2 + 0 * 4])
      this.mZ[idx].set(els[0 + 2 * 4], els[1 + 2 * 4], els[2 + 2 * 4])
      this.mSamples++
      const n = this.mSamples > this.mHistorySize ? this.mHistorySize : this.mSamples
      this.position = this.filterAVT(this.mP, n)
      const x = this.filterAVT(this.mX, n).normalize()
      const z = this.filterAVT(this.mZ, n).normalize()
      const up = new THREE.Vector3().crossVectors(z, x).normalize()
      this.rotation.setFromRotationMatrix(new THREE.Matrix4().lookAt(z, new THREE.Vector3(), up))
    }

    filterAVT(buf, n) {
      const mean = new THREE.Vector3()
      for (let i = 0; i < n; i++) {
        mean.add(buf[i])
      }
      mean.divideScalar(n)
      if (n <= 2) {
        return mean
      }
      let s = 0
      for (let i = 0; i < n; i++) {
        s += buf[i].distanceToSquared(mean)
      }
      s /= n
      const avg = new THREE.Vector3()
      let ib = 0
      for (let i = 0; i < n; i++) {
        const d = buf[i].distanceToSquared(mean)
        if (d <= s) {
          avg.add(buf[i])
          ib++
        }
      }
      if (ib > 0) {
        avg.divideScalar(ib)
        return avg
      }
      return mean
    }
  }

  const filter = new PoseFilter()

  const formatMapIds = () => {
    const mapIdArray = [mapIds.length]
    for (let i = 0; i < mapIds.length; i++) {
      mapIdArray[i] = {id: mapIds[i]}
    }
    return mapIdArray
  }

  const getIntrinsics = (m, w, h) => {
    const _fl = 0.5 * m[5] * h
    const _ox = 0.5 * (m[8] + 1.0) * w
    const _oy = 0.5 * (m[9] + 1.0) * h
    return {fx: _fl, fy: _fl, ox: _ox, oy: _oy}
  }

  const createWorker = (fn) => {
    const scripts = 'importScripts(\'https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js\', \'https://cdn.jsdelivr.net/gh/photopea/UPNG.js/UPNG.js\')\n'
    const blob = new Blob([scripts, 'self.onmessage = ', fn.toString()], {type: 'text/javascript'})
    const url = URL.createObjectURL(blob)
    return new Worker(url)
  }

  const pngWorker = createWorker((e) => {
    const {UPNG, pixels, width, height} = e.data
    const png = self.UPNG.encodeLL([pixels], width, height, 1, 0, 8, 0)
    self.postMessage(png)
  })

  const getImageData = async () => {
    return new Promise((resolve, reject) => {
      try {
        pngWorker.onmessage = (e) => {
          resolve(e.data)
        }
        pngWorker.onerror = (e) => {
          reject(e)
        }
        pngWorker.postMessage({pixels: cameraData.buffer, width: cameraData.width, height: cameraData.height})
      } catch (error) {
        reject(error)
      }
    })
  }

  const capture = async () => {
    const Q = new THREE.Quaternion()
    Q.set(cameraData.rotation.x, cameraData.rotation.y, cameraData.rotation.z, cameraData.rotation.w)
    Q.multiply(Qrot)
    const M = new THREE.Matrix4()
    M.makeRotationFromQuaternion(Q)
    const els = M.elements
    const m00 = els[0 + 0 * 4]
    const m10 = els[1 + 0 * 4]
    const m20 = els[2 + 0 * 4]

    const m01 = els[0 + 1 * 4]
    const m11 = els[1 + 1 * 4]
    const m21 = els[2 + 1 * 4]

    const m02 = els[0 + 2 * 4]
    const m12 = els[1 + 2 * 4]
    const m22 = els[2 + 2 * 4]

    const encodedImage = await getImageData()
    const json = {
      token: developerToken,
      run: 0,
      index: 0,
      anchor: false,
      px: cameraData.position.x,
      py: cameraData.position.y,
      pz: cameraData.position.z,
      r00: m00,
      r01: m01,
      r02: m02,
      r10: m10,
      r11: m11,
      r12: m12,
      r20: m20,
      r21: m21,
      r22: m22,
      fx: cameraData.intrinsics.fx,
      fy: cameraData.intrinsics.fy,
      ox: cameraData.intrinsics.ox,
      oy: cameraData.intrinsics.oy,
    }
    const payload = new Blob([JSON.stringify(json), '\0', encodedImage])

    const response = await fetch(BASE_URL + CAPTURE, {method: 'POST', body: payload})
    const data = await response.json()

    if (data.error == 'none') {
      console.log("Image captured successfully")
    }
    else {
      console.log("Image capture failed")
    }
  }

  // Localize an image with the Immersal VPS (on-server localizer).
  const localize = async () => {
    if (isLocalizing) {
      return
    }

    isLocalizing = true

    const {scene, camera, renderer} = XR8.Threejs.xrScene()
    const trackerSpace = camera.matrixWorld.clone()
    const encodedImage = await getImageData()
    const Q = new THREE.Quaternion()
    Q.set(cameraData.rotation.x, cameraData.rotation.y, cameraData.rotation.z, cameraData.rotation.w)
    Q.multiply(Qrot)
    const json = {
      token: developerToken,
      fx: cameraData.intrinsics.fx,
      fy: cameraData.intrinsics.fy,
      ox: cameraData.intrinsics.ox,
      oy: cameraData.intrinsics.oy,
      qx: Q.x,
      qy: Q.y,
      qz: Q.z,
      qw: Q.w,
      solverType: 1,
      mapIds: formatMapIds(),
    }
    // console.log(JSON.stringify(json))
    const payload = new Blob([JSON.stringify(json), '\0', encodedImage])

    const response = await fetch(BASE_URL + SERVER_LOCALIZE, {method: 'POST', body: payload})
    // console.log("response ok: " + response.ok)
    // console.log("status: " + response.status)

    const data = await response.json()
    // console.log("data: " + JSON.stringify(data))

    if (data.success) {
      console.log('Relocalized successfully')
      if (pointCloud) {
        const rm = new THREE.Matrix4()
        rm.set(data.r00, -data.r01, -data.r02, 0,
          data.r10, -data.r11, -data.r12, 0,
          data.r20, -data.r21, -data.r22, 0,
          0, 0, 0, 1)
        
        const scale = new THREE.Vector3(1, 1, 1)
        const position = new THREE.Vector3(data.px, data.py, data.pz)
        const rotation = new THREE.Quaternion()
        rotation.setFromRotationMatrix(rm)

        const cloudSpace = new THREE.Matrix4()
        cloudSpace.compose(position, rotation, scale)

        const m = new THREE.Matrix4().multiplyMatrices(trackerSpace, cloudSpace.invert())
        m.decompose(position, rotation, scale)
        
        pointCloud.scale.set(scale.x, scale.y, scale.z)

        if (useFilter) {
          filter.refinePose(m)
        } else {
          pointCloud.position.set(position.x, position.y, position.z)
          pointCloud.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w)
        }
      }
    } else {
      console.log('Failed to relocalize')
    }
    isLocalizing = false
  }

  const loadPLY = (mapId) => {
    const loader = new THREE.PLYLoader()

    let url = BASE_URL
    url += (pointCloudType === 1) ? DOWNLOAD_DENSE : DOWNLOAD_SPARSE
    url += '?token=' + developerToken + '&id=' + mapId

    loader.load(url, (geometry) => {
      const {scene, camera, renderer} = XR8.Threejs.xrScene()

      geometry.computeVertexNormals()
      geometry.computeFaceNormals()

      const material = new THREE.PointsMaterial({color: 0xFFFF00,
        vertexColors: THREE.VertexColors,
        size: 5,
        sizeAttenuation: false,
      })
      pointCloud = new THREE.Points(geometry, material)

      const box = new THREE.Box3().setFromObject(pointCloud)
      const size = box.getSize(new THREE.Vector3()).length()
      const center = box.getCenter(new THREE.Vector3())

      pointCloud.scale.set(1, 1, 1)

      scene.add(pointCloud)

      if (showAxes) {
        const axesHelper = new THREE.AxesHelper(1)
        axesHelper.position.x -= center.x
        axesHelper.position.y -= center.y
        axesHelper.position.z -= center.z
        scene.add(axesHelper)
      }
    })
  }

  return {
    name: 'immersal',
    onStart: ({canvas, canvasWidth, canvasHeight}) => {
      if (showPointCloud) {
        for (let i = 0; i < mapIds.length; i++) {
          loadPLY(mapIds[i])
        }
      }
      timer = setInterval(localize, localizationInterval)
    },
    onProcessCpu: ({processGpuResult}) => {
      const {camerapixelarray} = processGpuResult
      if (!camerapixelarray || !camerapixelarray.pixels) {
        return null
      }
      const {rows, cols, rowBytes, pixels} = camerapixelarray
      return {rows, cols, rowBytes, pixels}
    },
    onUpdate: ({frameStartResult, processGpuResult, processCpuResult}) => {
      if (!processCpuResult.reality) {
        return
      }

      const {rotation, position, intrinsics} = processCpuResult.reality
      const {textureWidth, textureHeight} = frameStartResult
      const {rows, cols, rowBytes, pixels} = processCpuResult.immersal

      cameraData.width = cols
      cameraData.height = rows
      cameraData.buffer = pixels

      Object.assign(cameraData.position, position)
      Object.assign(cameraData.rotation, rotation)
      Object.assign(cameraData.intrinsics, getIntrinsics(intrinsics, cols, rows))
    },
    onRender: () => {
      if (useFilter) {
        if (pointCloud) {
          const distSq = pointCloud.position.distanceToSquared(filter.position)
          const cosAngle = filter.rotation.dot(pointCloud.quaternion)

          if (filter.sampleCount() === 1 || distSq > warpThresholdDistSq || cosAngle < warpThresholdCosAngle) {
            pointCloud.position.set(filter.position.x, filter.position.y, filter.position.z)
            pointCloud.quaternion.set(filter.rotation.x, filter.rotation.y, filter.rotation.z, filter.rotation.w)
          } else {
            const smoothing = 0.025
            const currTime = performance.now()
            elapsedTime = (currTime - prevTime) / 1000
            prevTime = currTime
            let steps = elapsedTime / (1.0 / 60.0)
            if (steps < 1.0) {
              steps = 1.0
            } else if (steps > 6.0) {
              steps = 6.0
            }
            const alpha = 1.0 - Math.pow(1.0 - smoothing, steps)
            pointCloud.position.lerp(filter.position, alpha)
            pointCloud.quaternion.slerp(filter.rotation, alpha)
          }
        }
      }
    },
  }
}
