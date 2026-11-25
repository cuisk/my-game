import * as THREE from './vendor/three.module.js';

/*
 * 鹈鹕骑行 / Pelican Ride
 * 纯前端 3D 小游戏：Three.js + 程序化几何体 + 自定义海面着色器，无任何外部资源请求。
 *
 * 坐标约定：
 *   - 玩家固定在 z = 0，前进方向为 -Z；世界物体以 speed*dt 沿 +Z 移动，形成「自动前进」。
 *   - 路面 x ∈ [-6, 6]，三条车道中心 x = -3.3 / 0 / 3.3；左侧是沙滩与海，右侧是草地。
 *   - 路面按 40m 一段池化复用，超出玩家身后即搬到队尾，实现无限公路。
 *
 * 操作：A/D 或 ←/→ 横移；Shift 加速（冲刺状态可撞碎路障）；空格跳跃（空中免碰撞）；
 *       C/V 切视角；F 自由视角；G 复位视角；P 暂停。
 *       鼠标右键拖动 / 自由视角下左键拖动 = 旋转相机，滚轮 = 拉近拉远。
 */

{
  // ============================================================ 配置
  const CFG = {
    roadWidth: 12,
    laneX: [-3.3, 0, 3.3],
    limit: 4.6,              // 玩家可横移的最大 |x|
    chunkLen: 40,
    chunkCount: 9,
    baseSpeed: 20,          // m/s
    boostSpeed: 40,
    maxBaseSpeed: 29,
    spawnZ: -190,
    despawnZ: 22,
    magnetRadius: 2.9,      // 拾取物自动吸附半径
    coinPool: 72,
    heartPool: 12,
    obstaclePool: 24,
    particlePool: 96,
    jumpVelocity: 9.8,
    gravity: 22,
    clearHeight: 0.5,       // 离地半个车身高度即可越过路障，留足跳跃容错窗口
    bestKey: 'pelican-ride-best-v1',
  };

  // 预设视角：位置 / 注视点都是相对玩家的偏移，可再叠加自由旋转
  const CAMERAS = [
    { id: 'chase',   name: '追尾视角',     offset: [2.8, 3.4, 8.6], look: [0, 1.5, -14], fov: 68 },
    { id: 'cockpit', name: '车头第一视角', offset: [0, 2.95, 0.5],  look: [0, 2.1, -32], fov: 78 },
    { id: 'side',    name: '侧面跟拍',     offset: [10.5, 3.6, 3.0],look: [0, 1.4, -8],  fov: 62 },
    { id: 'top',     name: '高空俯视',     offset: [0, 21, 11],      look: [0, 0, -16],   fov: 60 },
  ];

  // ============================================================ 工具
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const damp = (cur, target, lambda, dt) => cur + (target - cur) * (1 - Math.exp(-lambda * dt));

  /** 生成一根从 a 指向 b 的圆柱，用于拼自行车车架 */
  function rod(a, b, radius, material, segments = 8) {
    const va = new THREE.Vector3(...a);
    const vb = new THREE.Vector3(...b);
    const dir = new THREE.Vector3().subVectors(vb, va);
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, dir.length(), segments),
      material
    );
    mesh.position.copy(va).add(vb).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    return mesh;
  }

  /** 生成可平铺的噪点纹理，用于沥青 / 沙地 / 草地，避免大片纯色塑料感 */
  function noiseTexture(base, amount, rx, ry, size = 128) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);
    const img = ctx.getImageData(0, 0, size, size);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * amount;
      d[i] = clamp(d[i] + n, 0, 255);
      d[i + 1] = clamp(d[i + 1] + n, 0, 255);
      d[i + 2] = clamp(d[i + 2] + n, 0, 255);
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(rx, ry);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  /** 径向柔光贴图：太阳光晕、血瓶光晕共用 */
  function glowTexture(inner = 'rgba(255,255,245,1)', mid = 'rgba(255,220,150,.55)') {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 64);
    g.addColorStop(0, inner);
    g.addColorStop(0.2, mid);
    g.addColorStop(0.55, 'rgba(255,190,110,.16)');
    g.addColorStop(1, 'rgba(255,180,100,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }

  /** 路牌文字贴图 */
  function signTexture() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 128;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#17658c'; ctx.fillRect(0, 0, 256, 128);
    ctx.strokeStyle = '#eaf7ff'; ctx.lineWidth = 7; ctx.strokeRect(9, 9, 238, 110);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 46px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('海岸线', 128, 62);
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText('COAST ROAD', 128, 98);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // ============================================================ DOM
  const dom = {
    canvas: document.getElementById('game'),
    score: document.getElementById('score'),
    coins: document.getElementById('coins'),
    distance: document.getElementById('distance'),
    smashes: document.getElementById('smashes'),
    best: document.getElementById('best'),
    readyBest: document.getElementById('ready-best'),
    lives: document.getElementById('lives'),
    combo: document.getElementById('combo'),
    toast: document.getElementById('toast'),
    energy: document.getElementById('energy-fill'),
    speed: document.getElementById('speed-val'),
    flash: document.getElementById('flash'),
    lines: document.getElementById('speed-lines'),
    fx: document.getElementById('fx-layer'),
    ready: document.getElementById('ready-screen'),
    over: document.getElementById('over-screen'),
    pause: document.getElementById('pause-screen'),
    error: document.getElementById('error-screen'),
    errorMsg: document.getElementById('error-msg'),
    finalScore: document.getElementById('final-score'),
    finalCoins: document.getElementById('final-coins'),
    finalDistance: document.getElementById('final-distance'),
    finalBest: document.getElementById('final-best'),
    finalSmashes: document.getElementById('final-smashes'),
    newRecord: document.getElementById('new-record'),
    overTitle: document.getElementById('over-title'),
    btnFree: document.getElementById('btn-free'),
  };

  // ============================================================ 全局状态
  const state = {
    phase: 'ready',           // ready | playing | paused | over
    score: 0, coins: 0, distance: 0, best: 0, smashes: 0, dodges: 0,
    combo: 0, comboTimer: 0,
    energy: 100, lives: 3, invuln: 0, shake: 0,
    speed: 0, boost: false, time: 0,
    targetX: 0, cameraIndex: 0,
    freeCam: false, jumpQueued: false,
    nextSpawn: 18,
  };

  // 自由旋转参数：yaw 水平角、pitch 仰角、dist 距离倍率
  const orbit = { yaw: 0, pitch: 0, dist: 1 };

  let renderer, scene, camera, clock;
  const camLook = new THREE.Vector3(0, 1.5, -14);
  let world, player, mats, glowTex, seaUniforms;
  let coins = [], hearts = [], obstacles = [], particles = [];
  let foamMeshes = [], surfMeshes = [];
  let spawnEnabled = true;   // 自动化验证时可临时关闭自然生成，隔离单个碰撞事件
  const keys = new Set();
  const input = {
    left: false, right: false, boost: false,
    dragId: null, dragMode: null, startX: 0, startY: 0,
    startTarget: 0, startYaw: 0, startPitch: 0,
  };
  let hudTimer = 0, toastTimer = null;

  // ============================================================ 材质
  function buildMaterials() {
    const lam = (color, extra) => new THREE.MeshLambertMaterial({ color, ...(extra || {}) });
    glowTex = glowTexture();
    mats = {
      road: lam(0xffffff, { map: noiseTexture('#4b5b64', 26, 3, 10) }),
      edge: lam(0xf3f6ef),
      dash: lam(0xffe6a3),
      sand: lam(0xffffff, { map: noiseTexture('#e6d1a5', 22, 5, 12) }),
      wetSand: lam(0xc9b389),
      grass: lam(0xffffff, { map: noiseTexture('#84b96c', 30, 10, 16) }),
      rut: new THREE.MeshBasicMaterial({ color: 0x22323a, transparent: true, opacity: 0.12, depthWrite: false }),
      shoulder: lam(0x9aa39a),
      pole: lam(0xdde8e8),
      trunk: lam(0x8d653e),
      leaf: lam(0x3f9e63, { side: THREE.DoubleSide }),
      leafDark: lam(0x2f7f4d, { side: THREE.DoubleSide }),
      rock: lam(0x9aa9a5, { flatShading: true }),
      island: lam(0x93bfbb),
      lamp: new THREE.MeshBasicMaterial({ color: 0xfff0b8 }),
      signPost: lam(0xb9c6c8),
      sign: new THREE.MeshBasicMaterial({ map: signTexture(), side: THREE.DoubleSide }),
      dark: lam(0x243239),
      chrome: new THREE.MeshPhongMaterial({ color: 0xdfeff3, shininess: 90 }),
      frame: lam(0x22b8c4),
      feather: lam(0xfff9ec),
      wing: lam(0xe9e0c8),
      beak: new THREE.MeshPhongMaterial({ color: 0xf6a72c, shininess: 45 }),
      pouch: lam(0xef8146),
      helmet: lam(0xff6f61),
      scarf: lam(0xff5f7e),
      basket: lam(0xc08a4e),
      eye: new THREE.MeshBasicMaterial({ color: 0x14222b }),
      shine: new THREE.MeshBasicMaterial({ color: 0xffffff }),
      gold: new THREE.MeshPhongMaterial({ color: 0xffc93c, emissive: 0x6d4200, emissiveIntensity: 0.65, shininess: 90 }),
      goldRing: new THREE.MeshPhongMaterial({ color: 0xfff0a8, emissive: 0x7a5200, emissiveIntensity: 0.5, shininess: 100 }),
      goldCore: new THREE.MeshBasicMaterial({ color: 0xfff6c8 }),
      potion: new THREE.MeshPhongMaterial({ color: 0xff3f5f, emissive: 0x8c1026, emissiveIntensity: 0.7, shininess: 90, transparent: true, opacity: 0.9 }),
      cork: lam(0xf3e0bd),
      cross: new THREE.MeshBasicMaterial({ color: 0xffffff }),
      orange: lam(0xf07b2f),
      whiteStripe: lam(0xfff4e6),
      crate: lam(0xb07a46),
      foam: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide }),
      shadow: new THREE.MeshBasicMaterial({ color: 0x0b2a33, transparent: true, opacity: 0.22, depthWrite: false }),
    };
  }

  // ============================================================ 天空 / 海 / 远景
  function buildSky() {
    const c = document.createElement('canvas');
    c.width = 8; c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0.00, '#2474bd');
    g.addColorStop(0.32, '#63b7e4');
    g.addColorStop(0.52, '#abe0f0');
    g.addColorStop(0.63, '#ffe2b3');
    g.addColorStop(0.72, '#ffd39a');
    g.addColorStop(1.00, '#f2b883');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 8, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(480, 32, 20),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false })
    );
    scene.add(sky);

    // 太阳：核心 + 大范围柔光晕
    const sun = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
    }));
    sun.position.set(-105, 62, -300);
    sun.scale.set(120, 120, 1);
    scene.add(sun);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xffd9a0, transparent: true, opacity: 0.35,
      depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
    }));
    halo.position.copy(sun.position);
    halo.scale.set(290, 290, 1);
    scene.add(halo);

    // 远处雾里的小岛
    const islands = new THREE.Group();
    const specs = [[-145, -230, 26], [-95, -270, 18], [110, -245, 30], [165, -300, 22]];
    for (const [x, z, s] of specs) {
      const hill = new THREE.Mesh(new THREE.ConeGeometry(s, s * 0.75, 6), mats.island);
      hill.position.set(x, s * 0.32 - 1, z);
      hill.rotation.y = Math.random() * Math.PI;
      islands.add(hill);
    }
    scene.add(islands);

    // 有明暗两层的云，比纯白球更有体积
    for (let i = 0; i < 9; i++) {
      const cloud = new THREE.Group();
      for (let j = 0; j < 4; j++) {
        const dark = j === 0;
        const puff = new THREE.Mesh(
          new THREE.SphereGeometry(1, 10, 8),
          new THREE.MeshBasicMaterial({
            color: dark ? 0xd7e5ec : 0xffffff,
            transparent: true, opacity: dark ? 0.55 : 0.82, fog: false,
          })
        );
        puff.scale.set(rand(7, 13), rand(2.2, 3.8), rand(4, 7));
        puff.position.set(j * 8 - 12, rand(-1.6, 1.2), rand(-2, 2));
        cloud.add(puff);
      }
      cloud.position.set(rand(-190, 190), rand(42, 82), rand(-280, -130));
      cloud.userData.drift = rand(0.35, 1.15);
      scene.add(cloud);
      world.clouds.push(cloud);
    }

    // 海鸥：绕圈盘旋 + 扇动翅膀
    for (let i = 0; i < 5; i++) {
      const g = new THREE.Group();
      const wingMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, fog: false });
      const wings = [];
      for (const s of [-1, 1]) {
        const pivot = new THREE.Group();
        const w = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.3), wingMat);
        w.position.x = s * 0.85;
        w.rotation.x = -Math.PI / 2;
        pivot.add(w);
        g.add(pivot);
        wings.push(pivot);
      }
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.24, 8, 6), wingMat);
      body.scale.set(1, 0.6, 1.8);
      g.add(body);
      scene.add(g);
      world.gulls.push({
        group: g, wings,
        cx: rand(-90, 40), cz: rand(-180, -60), y: rand(28, 52),
        radius: rand(12, 30), speed: rand(0.16, 0.32), phase: rand(0, Math.PI * 2),
      });
    }
  }

  /**
   * 海面：自定义 ShaderMaterial。
   * 顶点做 4 层正弦叠加的波浪位移并用有限差分求法线；
   * 片元做深浅水色、菲涅尔天光、波峰白沫、太阳镜面高光与闪烁碎斑、
   * 近岸浅滩与拍岸泡沫，最后按距离混雾。
   */
  function buildSea() {
    const uniforms = {
      uTime: { value: 0 },
      uDeep: { value: new THREE.Color(0x0a5680) },
      uShallow: { value: new THREE.Color(0x47c2d4) },
      uFoam: { value: new THREE.Color(0xf0ffff) },
      uSunColor: { value: new THREE.Color(0xffe0a0) },
      uFogColor: { value: new THREE.Color(0xbfe3f2) },
      uSunDir: { value: new THREE.Vector3(-0.42, 0.48, -0.77).normalize() },
      uFogNear: { value: 70 },
      uFogFar: { value: 260 },
    };
    const vertexShader = `
      uniform float uTime;
      varying float vWave;
      varying vec3 vWorld;
      varying vec3 vNormalW;

      float waveHeight(vec2 p, float t) {
        float h = 0.0;
        h += sin(p.x * 0.055 + t * 1.15) * 0.36;
        h += sin(p.y * 0.082 - t * 1.65) * 0.25;
        h += sin((p.x + p.y) * 0.135 + t * 2.25) * 0.13;
        h += sin(p.x * 0.21 - p.y * 0.13 + t * 3.10) * 0.05;
        return h;
      }

      void main() {
        vec3 p = position;
        vec2 q = p.xy;
        float h = waveHeight(q, uTime);
        p.z += h;
        vWave = h;
        float e = 0.7;
        float hx = waveHeight(q + vec2(e, 0.0), uTime) - waveHeight(q - vec2(e, 0.0), uTime);
        float hy = waveHeight(q + vec2(0.0, e), uTime) - waveHeight(q - vec2(0.0, e), uTime);
        vec3 n = normalize(vec3(-hx / (2.0 * e), -hy / (2.0 * e), 1.0));
        vNormalW = normalize(mat3(modelMatrix) * n);
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `;
    const fragmentShader = `
      uniform float uTime, uFogNear, uFogFar;
      uniform vec3 uDeep, uShallow, uFoam, uSunColor, uFogColor, uSunDir;
      varying float vWave;
      varying vec3 vWorld;
      varying vec3 vNormalW;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }

      void main() {
        float h = vWave;
        vec3 N = normalize(vNormalW);
        vec3 V = normalize(cameraPosition - vWorld);
        vec3 H = normalize(uSunDir + V);

        // 波谷深蓝、波峰青绿
        vec3 col = mix(uDeep, uShallow, smoothstep(-0.55, 0.45, h));
        // 掠射角反射天光
        float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
        col = mix(col, vec3(0.60, 0.84, 0.93), fres * 0.55);
        // 波峰碎白沫，带沿 z 的条带节奏
        float crest = smoothstep(0.24, 0.50, h);
        float streak = 0.60 + 0.40 * sin(vWorld.z * 0.65 + uTime * 3.4 + h * 9.0);
        col = mix(col, uFoam, crest * streak * 0.90);
        // 太阳镜面高光 + 高频闪烁的碎光斑
        float spec = pow(max(dot(N, H), 0.0), 90.0);
        float sparkle = pow(max(dot(N, H), 0.0), 900.0)
                      * step(0.80, hash(floor(vWorld.xz * 2.3) + floor(uTime * 6.0)));
        col += uSunColor * (spec * 1.45 + sparkle * 2.8);
        // 近岸浅滩（岸线 x = -28）与随浪推进的拍岸泡沫
        float shore = 1.0 - smoothstep(0.0, 24.0, abs(vWorld.x + 10.5));
        col = mix(col, vec3(0.53, 0.86, 0.88), shore * 0.40);
        float shoreFoam = smoothstep(0.76, 1.0, sin(vWorld.z * 0.34 - uTime * 1.7) * 0.5 + 0.5)
                        * (1.0 - smoothstep(0.0, 6.0, abs(vWorld.x + 10.5)));
        col = mix(col, uFoam, shoreFoam * 0.55);
        // 与场景雾对齐
        float d = length(cameraPosition - vWorld);
        col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, d));
        gl_FragColor = vec4(col, 1.0);
      }
    `;
    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry(520, 900, 120, 160),
      new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, side: THREE.DoubleSide })
    );
    sea.rotation.x = -Math.PI / 2;
    // 海岸线拉近到 x = -10.5，让海在默认视角里占据画面左侧而不是只剩一条边
    sea.position.set(-270.5, -0.45, -120);
    scene.add(sea);
    seaUniforms = uniforms;

    // 岸线白沫：几条随浪前后推移、明暗呼吸的长带
    for (let i = 0; i < 4; i++) {
      const mat = mats.foam.clone();
      mat.opacity = 0.34 + i * 0.07;
      const f = new THREE.Mesh(new THREE.PlaneGeometry(1.7 + i * 0.35, 900), mat);
      f.rotation.x = -Math.PI / 2;
      f.position.set(-10.25 - i * 0.8, 0.07 + i * 0.004, -120);
      foamMeshes.push(f);
      scene.add(f);
    }

    // 一排排从外海涌向岸边的短浪花：沿 +x 推进，靠近岸边淡出
    for (let i = 0; i < 26; i++) {
      const mat = mats.foam.clone();
      mat.opacity = 0.4;
      const s = new THREE.Mesh(new THREE.PlaneGeometry(rand(2.6, 4.6), rand(5, 11)), mat);
      s.rotation.x = -Math.PI / 2;
      s.rotation.z = rand(-0.12, 0.12);
      s.position.set(-18, -0.12, -430 + i * 19 + rand(-6, 6));
      s.userData.phase = rand(0, 18);
      s.userData.speed = rand(2.2, 3.4);
      surfMeshes.push(s);
      scene.add(s);
    }
  }

  // ============================================================ 路边景物
  function makePalm() {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.22, 3.5, 8), mats.trunk);
    trunk.position.y = 1.75; trunk.rotation.z = 0.07;
    g.add(trunk);
    for (let i = 0; i < 4; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.17 - i * 0.012, 0.018, 4, 10), mats.leafDark);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.7 + i * 0.78;
      g.add(ring);
    }
    for (let i = 0; i < 8; i++) {
      const pivot = new THREE.Group();
      pivot.position.y = 3.42;
      pivot.rotation.y = (i / 8) * Math.PI * 2;
      const leaf = new THREE.Mesh(new THREE.SphereGeometry(1, 7, 4), i % 2 ? mats.leaf : mats.leafDark);
      leaf.scale.set(0.29, 0.065, 1.22);
      leaf.position.set(0, 0, 1.0);
      leaf.rotation.x = 0.4;
      pivot.add(leaf);
      g.add(pivot);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.55, 4), mats.leaf);
      tip.rotation.x = Math.PI / 2 + 0.4;
      tip.position.set(0, -0.36, 1.95);
      pivot.add(tip);
    }
    for (let i = 0; i < 3; i++) {
      const nut = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), mats.trunk);
      nut.position.set(Math.cos(i * 2.1) * 0.22, 3.26, Math.sin(i * 2.1) * 0.22);
      g.add(nut);
    }
    return g;
  }

  function makeLamp() {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.12, 4.8, 8), mats.pole);
    pole.position.y = 2.4; g.add(pole);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.09, 0.09), mats.pole);
    arm.position.set(0.6, 4.72, 0); g.add(arm);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.16, 0.34), mats.lamp);
    head.position.set(1.15, 4.62, 0); g.add(head);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xffe6a0, transparent: true, opacity: 0.45,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    glow.position.set(1.15, 4.5, 0);
    glow.scale.set(2.6, 2.6, 1);
    g.add(glow);
    return g;
  }

  function makeRock() {
    const g = new THREE.Group();
    const r = new THREE.Mesh(new THREE.DodecahedronGeometry(0.8, 0), mats.rock);
    r.position.y = 0.4;
    r.scale.set(1, 0.7, 1.2);
    r.rotation.set(rand(0, 1), rand(0, 3), rand(0, 1));
    g.add(r);
    const r2 = new THREE.Mesh(new THREE.DodecahedronGeometry(0.35, 0), mats.rock);
    r2.position.set(0.7, 0.18, 0.4);
    g.add(r2);
    return g;
  }

  function makeSign() {
    const g = new THREE.Group();
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 2.6, 8), mats.signPost);
    post.position.y = 1.3; g.add(post);
    const back = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.25, 0.1), mats.signPost);
    back.position.y = 2.85; g.add(back);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(2.25, 1.12), mats.sign);
    board.position.set(0, 2.85, 0.06); g.add(board);
    return g;
  }

  /** 草地上的灌木丛，打破大片纯绿的单调 */
  function makeBush() {
    const g = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const b = new THREE.Mesh(new THREE.SphereGeometry(1, 7, 5), i === 1 ? mats.leafDark : mats.leaf);
      b.scale.set(rand(0.35, 0.6), rand(0.3, 0.45), rand(0.35, 0.6));
      b.position.set(rand(-0.5, 0.5), rand(0.2, 0.45), rand(-0.5, 0.5));
      g.add(b);
    }
    for (let i = 0; i < 3; i++) {
      const f = new THREE.Mesh(new THREE.SphereGeometry(0.075, 6, 4), mats.dash);
      f.position.set(rand(-0.5, 0.5), rand(0.45, 0.7), rand(-0.5, 0.5));
      g.add(f);
    }
    return g;
  }

  function decorateChunk(chunk) {
    chunk.props.forEach(p => {
      const x = p.side < 0 ? rand(-9.9, -7.1) : rand(11, 34);
      const z = -CFG.chunkLen / 2 + rand(1, CFG.chunkLen - 1);
      p.obj.position.set(x, 0, z);
      p.obj.rotation.y = rand(0, Math.PI * 2);
      p.obj.scale.setScalar(rand(0.85, 1.4));
      p.obj.visible = Math.random() > 0.1;
    });
  }

  function makeChunk() {
    const g = new THREE.Group();
    const add = (mesh, x, y, z) => { mesh.position.set(x, y, z); g.add(mesh); return mesh; };

    const road = new THREE.Mesh(new THREE.PlaneGeometry(CFG.roadWidth, CFG.chunkLen), mats.road);
    road.rotation.x = -Math.PI / 2; road.position.y = 0.02; g.add(road);

    // 车辙与路肩碎石带，给沥青一点层次
    for (const x of [-1.7, 1.7]) {
      const rut = new THREE.Mesh(new THREE.PlaneGeometry(0.75, CFG.chunkLen), mats.rut);
      rut.rotation.x = -Math.PI / 2;
      add(rut, x, 0.028, 0);
    }
    for (const x of [-5.9, 5.9]) {
      add(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.02, CFG.chunkLen), mats.edge), x, 0.045, 0);
    }
    for (const x of [-6.35, 6.35]) {
      add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, CFG.chunkLen), mats.shoulder), x, 0.005, 0);
    }
    for (let i = 0; i < 8; i++) {
      add(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.02, 2.2), mats.dash),
        0, 0.045, -CFG.chunkLen / 2 + 2.5 + i * 5);
    }

    const sand = new THREE.Mesh(new THREE.PlaneGeometry(4.6, CFG.chunkLen), mats.sand);
    sand.rotation.x = -Math.PI / 2; sand.position.set(-8.3, 0, 0); g.add(sand);
    const wet = new THREE.Mesh(new THREE.PlaneGeometry(2.6, CFG.chunkLen), mats.wetSand);
    wet.rotation.x = -Math.PI / 2; wet.position.set(-9.3, 0.012, 0); g.add(wet);
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(50, CFG.chunkLen), mats.grass);
    grass.rotation.x = -Math.PI / 2; grass.position.set(31, -0.01, 0); g.add(grass);

    // 靠海一侧的护栏 + 反光片
    for (let i = 0; i <= 5; i++) {
      add(new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.9, 0.14), mats.pole),
        -6.4, 0.45, -20 + i * 8);
      add(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.05), mats.orange),
        -6.32, 0.66, -20 + i * 8);
    }
    add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, CFG.chunkLen), mats.pole), -6.4, 0.82, 0);

    // 防波堤石块
    for (let i = 0; i < 4; i++) {
      const b = new THREE.Mesh(new THREE.DodecahedronGeometry(0.55, 0), mats.rock);
      b.position.set(-8.2, 0.24, -15 + i * 10);
      b.scale.set(1.2, 0.7, 1);
      b.rotation.y = rand(0, 3);
      g.add(b);
    }

    const props = [
      { obj: makePalm(), side: -1 }, { obj: makeRock(), side: -1 },
      { obj: makePalm(), side: 1 }, { obj: makeSign(), side: 1 },
      { obj: makeLamp(), side: 1 }, { obj: makeBush(), side: 1 },
    ];
    props.forEach(p => g.add(p.obj));
    const chunk = { group: g, props };
    decorateChunk(chunk);
    scene.add(g);
    return chunk;
  }

  // ============================================================ 鹈鹕 + 自行车
  function makeWheel() {
    const pivot = new THREE.Group();
    const tire = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.085, 8, 24), mats.dark);
    tire.rotation.y = Math.PI / 2; pivot.add(tire);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.024, 6, 24), mats.chrome);
    rim.rotation.y = Math.PI / 2; pivot.add(rim);
    for (let i = 0; i < 4; i++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.022, 1.08, 0.022), mats.chrome);
      spoke.rotation.x = i * Math.PI / 4;
      pivot.add(spoke);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.24, 10), mats.chrome);
    hub.rotation.z = Math.PI / 2;
    pivot.add(hub);
    return pivot;
  }

  function makeLeg(side) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.24, 1.62, 0.12);
    const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.06, 0.9, 8), mats.beak);
    shin.position.y = -0.45; pivot.add(shin);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.09, 0.36), mats.beak);
    foot.position.set(0, -0.9, -0.13); pivot.add(foot);
    const web = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.34, 3), mats.beak);
    web.rotation.x = -Math.PI / 2;
    web.position.set(0, -0.9, -0.38);
    pivot.add(web);
    return pivot;
  }

  function buildPlayer() {
    const rig = new THREE.Group();
    scene.add(rig);

    // --- 自行车 ---
    const wheelF = makeWheel(); wheelF.position.set(0, 0.62, -1.05); rig.add(wheelF);
    const wheelB = makeWheel(); wheelB.position.set(0, 0.62, 1.05); rig.add(wheelB);

    const rear = [0, 0.62, 1.05], seat = [0, 1.2, 0.28], headTube = [0, 1.32, -0.85];
    const front = [0, 0.62, -1.05], bb = [0, 0.62, 0.2];
    for (const [a, b] of [[rear, seat], [seat, headTube], [headTube, front], [rear, bb], [bb, seat], [bb, headTube]]) {
      rig.add(rod(a, b, 0.052, mats.frame));
    }
    const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.1, 0.62), mats.dark);
    saddle.position.set(...seat); rig.add(saddle);
    const seatPost = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.35, 8), mats.chrome);
    seatPost.position.set(0, 1.02, 0.28); rig.add(seatPost);

    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.06, 0.06), mats.chrome);
    bar.position.set(0, 1.44, -0.88); rig.add(bar);
    rig.add(rod([0, 1.32, -0.85], [0, 1.44, -0.88], 0.045, mats.chrome));
    for (const s of [-1, 1]) {
      const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.18, 8), mats.dark);
      grip.rotation.z = Math.PI / 2;
      grip.position.set(s * 0.44, 1.44, -0.88); rig.add(grip);
    }

    // 车篮
    const basket = new THREE.Mesh(
      new THREE.CylinderGeometry(0.36, 0.28, 0.36, 10, 1, true), mats.basket
    );
    basket.position.set(0, 1.16, -1.18); rig.add(basket);
    const basketRim = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.035, 6, 14), mats.basket);
    basketRim.rotation.x = Math.PI / 2;
    basketRim.position.set(0, 1.34, -1.18); rig.add(basketRim);

    const crank = new THREE.Group();
    crank.position.set(...bb);
    const armGeo = new THREE.BoxGeometry(0.06, 0.42, 0.06);
    const a1 = new THREE.Mesh(armGeo, mats.chrome); a1.position.y = 0.21;
    const a2 = new THREE.Mesh(armGeo, mats.chrome); a2.position.y = -0.21;
    crank.add(a1, a2);
    for (const s of [-1, 1]) {
      const pedal = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.05, 0.16), mats.dark);
      pedal.position.set(s * 0.13, s * 0.42, 0); crank.add(pedal);
    }
    const chainring = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.025, 6, 18), mats.chrome);
    chainring.rotation.y = Math.PI / 2; crank.add(chainring);
    rig.add(crank);

    // --- 鹈鹕 ---
    const bird = new THREE.Group();
    rig.add(bird);

    const body = new THREE.Mesh(new THREE.SphereGeometry(0.62, 16, 14), mats.feather);
    body.scale.set(0.92, 1.06, 1.24);
    body.position.set(0, 2.02, 0.16);
    bird.add(body);
    for (let i = -1; i <= 1; i++) {
      const tail = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.7, 5), mats.wing);
      tail.rotation.x = Math.PI / 2;
      tail.rotation.z = i * 0.22;
      tail.position.set(i * 0.18, 2.0 - Math.abs(i) * 0.05, 1.02);
      bird.add(tail);
    }

    const neck = rod([0, 2.38, -0.22], [0, 2.86, -0.72], 0.19, mats.feather, 10);
    bird.add(neck);
    // 红色小围巾 + 两条会飘的带子
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.21, 0.07, 6, 14), mats.scarf);
    collar.rotation.x = Math.PI / 2.6;
    collar.position.set(0, 2.47, -0.3);
    bird.add(collar);
    const ribbons = [];
    for (const s of [-1, 1]) {
      const ribbon = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.06, 0.85), mats.scarf);
      ribbon.position.set(s * 0.16, 2.4, 0.35);
      bird.add(ribbon);
      ribbons.push(ribbon);
    }

    const headGroup = new THREE.Group();
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.33, 14, 12), mats.feather);
    head.position.set(0, 2.92, -0.86);
    headGroup.add(head);
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), mats.eye);
      eye.position.set(s * 0.21, 2.98, -1.08); headGroup.add(eye);
      const glint = new THREE.Mesh(new THREE.SphereGeometry(0.026, 8, 6), mats.shine);
      glint.position.set(s * 0.21 + 0.025, 3.01, -1.14); headGroup.add(glint);
    }
    const helmet = new THREE.Mesh(
      new THREE.SphereGeometry(0.37, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), mats.helmet
    );
    helmet.position.set(0, 3.0, -0.86);
    headGroup.add(helmet);
    const brim = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.34), mats.helmet);
    brim.position.set(0, 3.0, -1.14);
    headGroup.add(brim);
    bird.add(headGroup);

    const beak = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.05, 1.45, 8), mats.beak);
    beak.rotation.x = Math.PI / 2;
    beak.position.set(0, 2.79, -1.67);
    bird.add(beak);
    const pouch = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 10), mats.pouch);
    pouch.scale.set(0.28, 0.23, 0.72);
    pouch.position.set(0, 2.59, -1.58);
    bird.add(pouch);

    const wingL = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), mats.wing);
    wingL.scale.set(0.17, 0.44, 0.72);
    wingL.position.set(-0.57, 2.05, 0.2);
    wingL.rotation.z = -0.18;
    bird.add(wingL);
    const wingR = wingL.clone();
    wingR.position.x = 0.57;
    wingR.rotation.z = 0.18;
    bird.add(wingR);

    const legL = makeLeg(-1), legR = makeLeg(1);
    rig.add(legL, legR);

    const shadow = new THREE.Mesh(new THREE.CircleGeometry(1.15, 24), mats.shadow);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(0, 0.06, 0.1);
    scene.add(shadow);

    return {
      rig, bird, body, wheelF, wheelB, crank, legL, legR,
      wingL, wingR, pouch, headGroup, shadow, ribbons,
      cockpitHidden: [bird, legL, legR],
      x: 0, prevX: 0, pedal: 0, pouchPunch: 0,
      bodyBaseY: 2.02,
      jumpY: 0, vy: 0, onGround: true, squash: 1,
    };
  }

  // ============================================================ 拾取物 / 障碍 / 粒子对象池
  function makeCoinMesh() {
    const g = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.44, 0.1, 20), mats.gold);
    disc.rotation.x = Math.PI / 2; g.add(disc);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.29, 0.045, 6, 18), mats.goldRing);
    ring.position.z = 0.06; g.add(ring);
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.095, 8, 6), mats.goldCore);
    core.position.z = 0.09; g.add(core);
    return g;
  }

  function makeHeartMesh() {
    const g = new THREE.Group();
    const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.5, 12), mats.potion);
    bottle.position.y = 0.28; g.add(bottle);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, 0.16, 10), mats.potion);
    neck.position.y = 0.6; g.add(neck);
    const cork = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.13, 10), mats.cork);
    cork.position.y = 0.72; g.add(cork);
    const cv = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.27, 0.025), mats.cross);
    cv.position.set(0, 0.28, 0.242); g.add(cv);
    const ch = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.075, 0.025), mats.cross);
    ch.position.set(0, 0.28, 0.242); g.add(ch);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xff5577, transparent: true, opacity: 0.75,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    glow.position.y = 0.38;
    glow.scale.set(1.7, 1.7, 1);
    g.add(glow);
    return { group: g, glow };
  }

  function makeObstacleMesh() {
    const g = new THREE.Group();
    const cone = new THREE.Group();
    const cm = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.5, 1.1, 4), mats.orange);
    cm.position.y = 0.6; cm.rotation.y = Math.PI / 4; cone.add(cm);
    const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.36, 0.2, 4), mats.whiteStripe);
    stripe.position.y = 0.62; stripe.rotation.y = Math.PI / 4; cone.add(stripe);
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.1, 0.92), mats.dark);
    base.position.y = 0.05; cone.add(base);
    g.add(cone);

    const crate = new THREE.Mesh(new THREE.BoxGeometry(1.12, 1.12, 1.12), mats.crate);
    crate.position.y = 0.56; g.add(crate);

    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.78, 0), mats.rock);
    rock.position.y = 0.55; g.add(rock);

    return { group: g, variants: [cone, crate, rock] };
  }

  function buildPools() {
    for (let i = 0; i < CFG.coinPool; i++) {
      const mesh = makeCoinMesh();
      mesh.visible = false; scene.add(mesh);
      coins.push({ mesh, active: false, magnet: false, x: 0, y: 0, z: 0, seed: Math.random() * 10 });
    }
    for (let i = 0; i < CFG.heartPool; i++) {
      const built = makeHeartMesh();
      built.group.visible = false; scene.add(built.group);
      hearts.push({ ...built, active: false, magnet: false, x: 0, y: 0, z: 0, seed: Math.random() * 10 });
    }
    for (let i = 0; i < CFG.obstaclePool; i++) {
      const built = makeObstacleMesh();
      built.group.visible = false; scene.add(built.group);
      obstacles.push({ ...built, active: false, x: 0, z: 0 });
    }
    for (let i = 0; i < CFG.particlePool; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffd35c, transparent: true, opacity: 1, depthWrite: false });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.085, 6, 5), mat);
      mesh.visible = false; scene.add(mesh);
      particles.push({ mesh, life: 0, vx: 0, vy: 0, vz: 0 });
    }
  }

  function take(pool) { return pool.find(o => !o.active); }

  function spawnCoin(x, z, y) {
    const c = take(coins);
    if (!c) return;
    c.active = true; c.magnet = false;
    c.x = x; c.y = y || 1.25; c.z = z;
    c.mesh.visible = true; c.mesh.scale.setScalar(1);
    c.mesh.position.set(c.x, c.y, c.z);
    c.seed = Math.random() * 10;
  }

  function spawnHeart(x, z, y) {
    const h = take(hearts);
    if (!h) return;
    h.active = true; h.magnet = false;
    h.x = x; h.y = y || 1.35; h.z = z;
    h.group.visible = true; h.group.scale.setScalar(1);
    h.group.position.set(h.x, h.y, h.z);
    h.seed = Math.random() * 10;
  }

  function spawnObstacle(x, z) {
    const o = take(obstacles);
    if (!o) return;
    o.active = true; o.x = x; o.z = z; o.dodged = false;
    o.group.visible = true;
    o.group.position.set(x, 0, z);
    o.group.rotation.y = rand(-0.3, 0.3);
    const pick = Math.floor(rand(0, 3));
    o.variants.forEach((v, i) => { v.visible = i === pick; });
  }

  function burst(x, y, z, color = 0xffd35c, count = 8, power = 1) {
    let made = 0;
    for (const p of particles) {
      if (p.life > 0) continue;
      p.life = rand(0.35, 0.68) * power;
      p.mesh.material.color.setHex(color);
      p.mesh.material.opacity = 1;
      p.mesh.scale.setScalar(rand(0.75, 1.5));
      p.mesh.visible = true;
      p.mesh.position.set(x, y, z);
      p.vx = rand(-3.2, 3.2) * power;
      p.vy = rand(1.2, 5) * power;
      p.vz = rand(-3, 2) * power;
      if (++made >= count) break;
    }
  }

  // ============================================================ 反馈效果
  function popText(text, color) {
    const el = document.createElement('div');
    el.className = 'pop';
    el.textContent = text;
    el.style.left = (48 + rand(-7, 7)) + '%';
    el.style.top = (42 + rand(-5, 5)) + '%';
    el.style.color = color;
    dom.fx.appendChild(el);
    setTimeout(() => el.remove(), 900);
  }

  function showToast(text, ms = 1100) {
    dom.toast.textContent = text;
    dom.toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => dom.toast.classList.remove('on'), ms);
  }

  function flash() {
    dom.flash.classList.add('on');
    setTimeout(() => dom.flash.classList.remove('on'), 110);
  }

  function updateLives(healedIndex) {
    for (let i = 0; i < dom.lives.children.length; i++) {
      const el = dom.lives.children[i];
      el.classList.toggle('lost', i >= state.lives);
      if (healedIndex === i) {
        el.classList.remove('heal');
        void el.offsetWidth;
        el.classList.add('heal');
      }
    }
  }

  // ============================================================ 玩法
  function collectCoin(c) {
    c.active = false; c.mesh.visible = false;
    burst(c.x, c.y, c.z, 0xffd35c, 9, 1);
    player.pouchPunch = 1;
    if (state.phase !== 'playing') return;
    state.combo = Math.min(state.combo + 1, 12);
    state.comboTimer = 1.7;
    const mult = Math.min(1 + Math.floor(state.combo / 3), 5);
    const gain = 10 * mult;
    state.score += gain;
    state.coins += 1;
    state.energy = Math.min(100, state.energy + 6);
    popText(mult > 1 ? `+${gain}  x${mult}` : `+${gain}`, '#ffd35c');
  }

  function collectHeart(h) {
    h.active = false; h.group.visible = false;
    burst(h.x, h.y, h.z, 0xff6d86, 12, 1);
    if (state.phase !== 'playing') return;
    if (state.lives < 3) {
      state.lives += 1;
      updateLives(state.lives - 1);
      popText('+1 生命', '#7cf0b0');
      showToast('回血了！');
    } else {
      // 满血时转化为分数与能量，拾取永远不亏
      state.score += 40;
      state.energy = Math.min(100, state.energy + 20);
      popText('+40 满血奖励', '#7cf0b0');
    }
  }

  /** 冲刺状态下把路障撞成碎片，不但不掉血，还额外加分 */
  function smashObstacle(o) {
    o.active = false; o.group.visible = false;
    burst(o.x, 0.8, o.z, 0xffa14a, 18, 1.5);
    if (state.phase !== 'playing') return;
    state.smashes += 1;
    state.score += 25;
    state.energy = Math.min(100, state.energy + 4);
    state.shake = Math.max(state.shake, 0.32);
    popText('撞碎 +25', '#ffcf87');
  }

  function hitObstacle(o) {
    o.active = false; o.group.visible = false;
    burst(o.x, 0.8, o.z, 0xff7a68, 10, 1.1);
    state.lives -= 1;
    state.energy = Math.max(0, state.energy - 22);
    state.speed *= 0.42;
    state.invuln = 1.7;
    state.shake = 0.65;
    state.combo = 0;
    flash();
    popText('-1', '#ff8f7d');
    updateLives();
    if (state.lives <= 0) gameOver();
    else showToast('小心路障');
  }

  /** 生成一组道具；safeOnly 用于开局预热，只铺金币 */
  function spawnPattern(z0, safeOnly) {
    const lane = Math.floor(rand(0, 3));
    if (safeOnly || Math.random() < 0.74) {
      const n = 3 + Math.floor(rand(0, 4));
      let cur = lane;
      for (let i = 0; i < n; i++) {
        spawnCoin(CFG.laneX[cur] + rand(-0.25, 0.25), z0 - i * 3.5, 1.25 + Math.sin(i * 0.8) * 0.22);
        if (i === 2 && Math.random() < 0.45) cur = clamp(cur + (Math.random() < 0.5 ? -1 : 1), 0, 2);
      }
      if (!safeOnly && Math.random() < 0.26) spawnObstacle(CFG.laneX[(lane + 1) % 3], z0 - 9);
    } else {
      spawnObstacle(CFG.laneX[lane], z0);
      if (Math.random() < 0.55) spawnObstacle(CFG.laneX[(lane + 1) % 3], z0 - 7);
      const safe = (lane + 2) % 3;
      for (let i = 0; i < 3; i++) spawnCoin(CFG.laneX[safe], z0 - i * 3.5, 1.3);
    }
    // 血瓶：受伤后更容易刷出，形成「撞了 → 找血瓶」的节奏
    if (!safeOnly) {
      const chance = state.lives < 3 ? 0.45 : 0.15;
      if (Math.random() < chance) {
        spawnHeart(CFG.laneX[Math.floor(rand(0, 3))], z0 - rand(4, 12), 1.35);
      }
    }
  }

  function updateSpawner(dz) {
    if (state.phase !== 'playing' || !spawnEnabled) return;
    state.nextSpawn -= dz;
    if (state.nextSpawn > 0) return;
    state.nextSpawn = rand(11, 24);
    spawnPattern(CFG.spawnZ + rand(0, 22), false);
  }

  /** 金币与血瓶共用磁吸逻辑；跳跃时拾取目标跟着抬高 */
  function updatePickups(list, dt, dz, onCollect, spin) {
    const ty = 2.0 + player.jumpY;
    for (const c of list) {
      if (!c.active) continue;
      const mesh = c.mesh || c.group;
      mesh.rotation.y += dt * spin;
      if (!c.magnet) {
        const prevZ = c.z;
        c.z += dz;
        mesh.position.set(c.x, c.y + Math.sin(state.time * 3 + c.seed) * 0.12, c.z);
        if (c.glow) c.glow.material.opacity = 0.55 + Math.sin(state.time * 4 + c.seed) * 0.2;
        // 扫掠判定：加速或掉帧时一帧位移很大，也不能从拾取窗口里漏过去
        if (state.phase === 'playing' && prevZ < 3 && c.z > -12 &&
            Math.abs(c.x - player.x) < CFG.magnetRadius) {
          c.magnet = true;
        }
        if (c.z > CFG.despawnZ) { c.active = false; mesh.visible = false; }
      } else {
        const tx = player.x, tz = -0.55;
        c.x = damp(c.x, tx, 14, dt);
        c.y = damp(c.y, ty, 14, dt);
        c.z = damp(c.z, tz, 14, dt);
        mesh.position.set(c.x, c.y, c.z);
        const d = Math.hypot(c.x - tx, c.y - ty, c.z - tz);
        mesh.scale.setScalar(clamp(d * 0.45 + 0.35, 0.3, 1));
        if (d < 0.55) onCollect(c);
      }
    }
  }

  function updateObstacles(dt, dz) {
    const boosting = state.boost && state.energy > 0;
    for (const o of obstacles) {
      if (!o.active) continue;
      // 扫掠判定：用上一帧到这一帧的 z 区间判断是否穿过玩家，低帧率下不会漏碰撞
      const prevZ = o.z;
      o.z += dz;
      o.group.position.z = o.z;
      o.group.rotation.y += dt * 0.35;
      const crossed = prevZ < 1.5 && o.z > -1.5;
      if (state.phase === 'playing' && state.invuln <= 0 &&
          crossed && Math.abs(o.x - player.x) < 1.08) {
        if (boosting) {
          smashObstacle(o);                     // 冲刺：直接撞碎
        } else if (player.jumpY > CFG.clearHeight) {
          // 空中：干净地越过，同一个障碍只给一次闪避奖励
          if (!o.dodged) {
            o.dodged = true;
            state.dodges += 1;
            state.score += 10;
            burst(o.x, 0.5, o.z, 0xbdefff, 6, 0.7);
            popText('漂亮闪避 +10', '#9fe4ff');
          }
        } else {
          hitObstacle(o);
        }
      }
      if (o.z > CFG.despawnZ) { o.active = false; o.group.visible = false; }
    }
  }

  function updateParticles(dt, dz) {
    for (const p of particles) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.mesh.visible = false; continue; }
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += (p.vz + dz / Math.max(dt, 0.001) * 0.35) * dt;
      p.vy -= 9 * dt;
      p.mesh.material.opacity = clamp(p.life * 2.2, 0, 1);
    }
  }

  // ============================================================ 玩家 / 相机
  function updatePlayer(dt) {
    // 键盘 + 触控按钮：连续横移
    const goL = keys.has('ArrowLeft') || keys.has('KeyA') || input.left;
    const goR = keys.has('ArrowRight') || keys.has('KeyD') || input.right;
    if (goL) state.targetX -= 9.5 * dt;
    if (goR) state.targetX += 9.5 * dt;
    state.targetX = clamp(state.targetX, -CFG.limit, CFG.limit);

    player.prevX = player.x;
    player.x = damp(player.x, state.targetX, 10, dt);
    player.rig.position.x = player.x;
    player.shadow.position.x = player.x;

    // 跳跃：起跳 → 重力 → 落地压一下（squash）
    if (state.jumpQueued) {
      if (player.onGround && state.phase === 'playing') {
        player.vy = CFG.jumpVelocity;
        player.onGround = false;
        burst(player.x, 0.3, 0.4, 0xdfeef0, 6, 0.6);
      }
      state.jumpQueued = false;
    }
    if (!player.onGround) {
      player.vy -= CFG.gravity * dt;
      player.jumpY += player.vy * dt;
      if (player.jumpY <= 0) {
        player.jumpY = 0; player.vy = 0; player.onGround = true;
        player.squash = 0.86;
        burst(player.x, 0.2, 0.3, 0xf0e2c0, 5, 0.6);
      }
    }
    player.squash = damp(player.squash, 1, 11, dt);

    // 转向倾角 + 加速前倾 + 起跳/下落的俯仰
    const vx = (player.x - player.prevX) / Math.max(dt, 0.001);
    const airbornePitch = player.onGround ? 0 : (player.vy > 0 ? -0.13 : 0.09);
    player.rig.rotation.z = damp(player.rig.rotation.z, clamp(-vx * 0.026, -0.3, 0.3), 9, dt);
    player.rig.rotation.x = damp(player.rig.rotation.x, (state.boost ? -0.045 : 0) + airbornePitch, 6, dt);

    // 踩踏：曲柄 / 车轮 / 双腿 / 翅膀 / 身体起伏联动
    player.pedal += state.speed * dt * 0.85;
    const s = Math.sin(player.pedal);
    player.crank.rotation.x = player.pedal;
    player.wheelF.rotation.x = -player.pedal * 0.58;
    player.wheelB.rotation.x = -player.pedal * 0.58;
    player.legL.rotation.x = 0.18 + s * 0.46;
    player.legR.rotation.x = 0.18 - s * 0.46;
    player.body.position.y = player.bodyBaseY + Math.abs(s) * 0.045;
    player.bird.position.y = Math.sin(player.pedal * 2) * 0.022;
    player.wingL.rotation.z = -0.18 - s * 0.1;
    player.wingR.rotation.z = 0.18 + s * 0.1;
    // 围巾随风向后飘，加速时更明显
    player.ribbons.forEach((r, i) => {
      r.rotation.x = -0.35 - (state.boost ? 0.35 : 0.12) + Math.sin(state.time * 9 + i) * 0.16;
    });

    player.rig.position.y = player.jumpY + Math.sin(player.pedal * 2) * 0.018;
    player.rig.scale.y = player.squash;

    // 影子随腾空缩小变淡
    const lift = clamp(1 - player.jumpY * 0.16, 0.45, 1);
    player.shadow.scale.setScalar(lift);
    player.shadow.material.opacity = 0.22 * lift;

    // 吃到金币时喉囊鼓起
    player.pouchPunch = Math.max(0, player.pouchPunch - dt * 3.2);
    player.pouch.scale.z = 0.72 + player.pouchPunch * 0.4;
    player.pouch.scale.y = 0.23 + player.pouchPunch * 0.14;

    player.rig.visible = state.invuln > 0 ? Math.sin(state.time * 34) > -0.2 : true;
    player.shadow.visible = player.rig.visible;
  }

  function applyCameraVisibility() {
    const hide = !state.freeCam && CAMERAS[state.cameraIndex].id === 'cockpit';
    player.cockpitHidden.forEach(o => { o.visible = !hide; });
  }

  function updateCamera(dt) {
    const cfg = CAMERAS[state.cameraIndex];
    const px = player.x * (cfg.id === 'cockpit' ? 1 : 0.42);
    // 竖屏时水平视野天然更窄：相机回正、拉远并放宽 FOV
    const narrow = camera.aspect < 0.85 && cfg.id !== 'cockpit';
    const base = new THREE.Vector3(
      cfg.offset[0] * (narrow ? 0.45 : 1),
      cfg.offset[1] * (narrow ? 1.08 : 1),
      cfg.offset[2] * (narrow ? 1.22 : 1)
    );
    const look = new THREE.Vector3(px * 0.6 + cfg.look[0], cfg.look[1], cfg.look[2]);
    let target;

    if (state.freeCam) {
      // 自由视角：绕「玩家前方一点」做球坐标公转，yaw/pitch/dist 完全由玩家控制
      const center = new THREE.Vector3(player.x, 1.55 + player.jumpY * 0.35, -2.0);
      const r = 11 * orbit.dist;
      const yaw = orbit.yaw + Math.PI;
      const phi = clamp(orbit.pitch + 0.3, -0.12, 1.3);
      target = new THREE.Vector3(
        center.x + r * Math.cos(phi) * Math.sin(yaw),
        center.y + r * Math.sin(phi),
        center.z + r * Math.cos(phi) * Math.cos(yaw)
      );
      look.copy(center);
    } else if (cfg.id === 'cockpit') {
      // 第一人称是固定视点，不做轨道旋转，避免相机跑进场景内部
      target = base.clone().add(new THREE.Vector3(px, 0, 0));
    } else {
      // 预设视角叠加右键/滚轮的轨道微调
      const rel = base.clone().sub(look);
      const r0 = rel.length();
      const theta = Math.atan2(rel.x, rel.z) + orbit.yaw;
      const phi = clamp(Math.asin(rel.y / r0) + orbit.pitch, -0.15, 1.35);
      const r = r0 * orbit.dist;
      target = new THREE.Vector3(
        look.x + r * Math.cos(phi) * Math.sin(theta),
        look.y + r * Math.sin(phi),
        look.z + r * Math.cos(phi) * Math.cos(theta)
      );
    }

    if (state.shake > 0) {
      target.x += (Math.random() - 0.5) * state.shake;
      target.y += (Math.random() - 0.5) * state.shake;
    }
    camera.position.x = damp(camera.position.x, target.x, 6.5, dt);
    camera.position.y = damp(camera.position.y, target.y, 6.5, dt);
    camera.position.z = damp(camera.position.z, target.z, 6.5, dt);
    camLook.lerp(look, 1 - Math.exp(-6.5 * dt));
    camera.lookAt(camLook);

    const targetFov = cfg.fov + (narrow ? 8 : 0) +
      (state.boost && state.energy > 0 && state.phase === 'playing' ? 10 : 0);
    const nf = damp(camera.fov, targetFov, 4, dt);
    if (Math.abs(nf - camera.fov) > 0.02) { camera.fov = nf; camera.updateProjectionMatrix(); }
  }

  function cycleCamera() {
    state.cameraIndex = (state.cameraIndex + 1) % CAMERAS.length;
    resetOrbit(false);
    applyCameraVisibility();
    showToast(`视角：${CAMERAS[state.cameraIndex].name}`);
  }

  function resetOrbit(notify = true) {
    orbit.yaw = 0; orbit.pitch = 0; orbit.dist = 1;
    if (notify) showToast('视角已复位');
  }

  function toggleFreeCam() {
    state.freeCam = !state.freeCam;
    resetOrbit(false);
    dom.btnFree.classList.toggle('active', state.freeCam);
    dom.btnFree.textContent = state.freeCam ? '退出自由' : '自由';
    applyCameraVisibility();
    showToast(state.freeCam ? '自由视角：拖动旋转 · 滚轮缩放 · G 复位' : '已退出自由视角', 1600);
  }

  function jump() {
    state.jumpQueued = true;
  }

  // ============================================================ 世界推进
  function updateWorld(dt, dz) {
    for (const chunk of world.chunks) {
      chunk.group.position.z += dz;
      if (chunk.group.position.z > CFG.chunkLen) {
        chunk.group.position.z -= CFG.chunkLen * CFG.chunkCount;
        decorateChunk(chunk);
      }
    }
    // 海面波浪由 GPU 计算，CPU 每帧只更新时间 uniform
    seaUniforms.uTime.value += dt;
    const t = seaUniforms.uTime.value;
    foamMeshes.forEach((f, i) => {
      f.position.x = -10.25 - i * 0.8 + Math.sin(t * 0.85 + i * 1.3) * 0.55;
      f.material.opacity = (0.28 + i * 0.07) * (0.65 + 0.35 * Math.sin(t * 1.6 + i * 2.1));
    });
    // 短浪花从外海向岸边推进，靠近岸时淡出，形成一排排涌岸的浪
    for (const s of surfMeshes) {
      const p = (t * s.userData.speed + s.userData.phase) % 18;
      s.position.x = -10.5 - (18 - p);
      s.material.opacity = 0.55 * Math.sin(Math.PI * p / 18);
    }
    for (const cloud of world.clouds) {
      cloud.position.x += cloud.userData.drift * dt;
      if (cloud.position.x > 210) cloud.position.x = -210;
    }
    for (const g of world.gulls) {
      g.phase += dt * g.speed;
      g.group.position.set(
        g.cx + Math.cos(g.phase) * g.radius,
        g.y + Math.sin(g.phase * 2) * 2.2,
        g.cz + Math.sin(g.phase) * g.radius
      );
      g.group.rotation.y = -g.phase + Math.PI / 2;
      const flap = Math.sin(state.time * 6 + g.phase) * 0.45;
      g.wings[0].rotation.z = 0.25 + flap;
      g.wings[1].rotation.z = -0.25 - flap;
    }
  }

  // ============================================================ HUD
  function updateHUD(dt) {
    hudTimer -= dt;
    if (hudTimer > 0) return;
    hudTimer = 0.08;
    dom.score.textContent = Math.floor(state.score).toLocaleString('zh-CN');
    dom.coins.textContent = state.coins;
    dom.distance.textContent = Math.floor(state.distance);
    dom.smashes.textContent = state.smashes;
    dom.best.textContent = state.best.toLocaleString('zh-CN');
    dom.speed.textContent = Math.round(state.speed * 3.6) + ' km/h';
    dom.energy.style.width = state.energy.toFixed(1) + '%';
    dom.energy.classList.toggle('low', state.energy < 25);
    const showCombo = state.combo >= 3 && state.comboTimer > 0;
    dom.combo.classList.toggle('on', showCombo);
    if (showCombo) dom.combo.textContent = `连击 x${Math.min(1 + Math.floor(state.combo / 3), 5)}`;
    dom.lines.classList.toggle('on', state.boost && state.energy > 0 && state.phase === 'playing');
  }

  // ============================================================ 流程控制
  function readBest() {
    try { return parseInt(localStorage.getItem(CFG.bestKey) || '0', 10) || 0; }
    catch (e) { return 0; }
  }
  function writeBest(v) {
    try { localStorage.setItem(CFG.bestKey, String(v)); } catch (e) { /* 隐私模式下忽略 */ }
  }

  function reset() {
    state.score = 0; state.coins = 0; state.distance = 0; state.smashes = 0; state.dodges = 0;
    state.combo = 0; state.comboTimer = 0;
    state.energy = 100; state.lives = 3; state.invuln = 0; state.shake = 0;
    state.speed = CFG.baseSpeed; state.boost = false;
    state.targetX = 0; state.nextSpawn = 16; state.jumpQueued = false;
    player.x = 0; player.prevX = 0; player.rig.position.set(0, 0, 0);
    player.rig.scale.setScalar(1);
    player.jumpY = 0; player.vy = 0; player.onGround = true; player.squash = 1;
    player.rig.visible = true; player.shadow.visible = true;
    player.shadow.material.opacity = 0.22;
    resetOrbit(false);
    for (let i = 0; i < world.chunks.length; i++) world.chunks[i].group.position.z = -i * CFG.chunkLen;
    for (const c of coins) { c.active = false; c.magnet = false; c.mesh.visible = false; }
    for (const h of hearts) { h.active = false; h.magnet = false; h.group.visible = false; }
    for (const o of obstacles) { o.active = false; o.group.visible = false; }
    for (const p of particles) { p.life = 0; p.mesh.visible = false; }
    dom.fx.innerHTML = '';
    updateLives();
    applyCameraVisibility();
    // 开局预热：先把前方 160m 铺上金币
    for (let i = 0; i < 5; i++) spawnPattern(-32 - i * 32, true);
  }

  function start() {
    reset();
    state.phase = 'playing';
    dom.ready.classList.add('hidden');
    dom.over.classList.add('hidden');
    dom.pause.classList.add('hidden');
    dom.readyBest.textContent = state.best.toLocaleString('zh-CN');
    showToast('出发！');
  }

  function gameOver() {
    state.phase = 'over';
    state.boost = false;
    dom.lines.classList.remove('on');
    const final = Math.floor(state.score);
    const record = final > state.best;
    if (record) { state.best = final; writeBest(final); }
    dom.finalScore.textContent = final.toLocaleString('zh-CN');
    dom.finalCoins.textContent = state.coins;
    dom.finalDistance.textContent = Math.floor(state.distance) + ' m';
    dom.finalBest.textContent = state.best.toLocaleString('zh-CN');
    dom.finalSmashes.textContent = state.smashes;
    dom.newRecord.classList.toggle('hidden', !record);
    dom.overTitle.textContent = record ? '新纪录！' : (state.smashes > 5 ? '开路先锋' : '骑得不错');
    dom.readyBest.textContent = state.best.toLocaleString('zh-CN');
    dom.best.textContent = state.best.toLocaleString('zh-CN');
    dom.over.classList.remove('hidden');
  }

  function togglePause() {
    if (state.phase === 'playing') {
      state.phase = 'paused';
      dom.pause.classList.remove('hidden');
    } else if (state.phase === 'paused') {
      state.phase = 'playing';
      dom.pause.classList.add('hidden');
    }
  }

  // ============================================================ 输入
  function bindHold(el, down, up) {
    el.addEventListener('pointerdown', e => {
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
      el.classList.add('pressed');
      down();
    });
    const end = () => { el.classList.remove('pressed'); up(); };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
  }

  function setupInput() {
    window.addEventListener('keydown', e => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) e.preventDefault();
      const first = !keys.has(e.code);
      keys.add(e.code);
      if (!first) return;   // 长按不重复触发一次性动作
      if (e.code === 'KeyC' || e.code === 'KeyV') cycleCamera();
      if (e.code === 'KeyF') toggleFreeCam();
      if (e.code === 'KeyG') resetOrbit();
      if (e.code === 'KeyP' || e.code === 'Escape') togglePause();
      if (e.code === 'Space') {
        if (state.phase === 'ready' || state.phase === 'over') start();
        else jump();
      }
      if ((e.code === 'Enter' || e.code === 'KeyR') && (state.phase === 'ready' || state.phase === 'over')) start();
      if (e.code === 'ArrowUp' || e.code === 'KeyW') jump();
    });
    window.addEventListener('keyup', e => keys.delete(e.code));
    window.addEventListener('blur', () => keys.clear());

    // 画布拖动：自由视角 / 右键 = 旋转相机，其余 = 左右横移
    dom.canvas.addEventListener('contextmenu', e => e.preventDefault());
    dom.canvas.addEventListener('pointerdown', e => {
      if (state.phase !== 'playing') return;
      input.dragId = e.pointerId;
      input.dragMode = (e.button === 2 || state.freeCam) ? 'rotate' : 'move';
      input.startX = e.clientX; input.startY = e.clientY;
      input.startTarget = state.targetX;
      input.startYaw = orbit.yaw;
      input.startPitch = orbit.pitch;
      try { dom.canvas.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
    });
    dom.canvas.addEventListener('pointermove', e => {
      if (input.dragId !== e.pointerId || state.phase !== 'playing') return;
      const dx = e.clientX - input.startX, dy = e.clientY - input.startY;
      if (input.dragMode === 'rotate') {
        orbit.yaw = clamp(input.startYaw - dx * 0.006, -Math.PI * 2.4, Math.PI * 2.4);
        orbit.pitch = clamp(input.startPitch + dy * 0.004, -0.62, 1.05);
      } else {
        state.targetX = clamp(input.startTarget + dx * 0.03, -CFG.limit, CFG.limit);
      }
    });
    const endDrag = e => { if (input.dragId === e.pointerId) { input.dragId = null; input.dragMode = null; } };
    dom.canvas.addEventListener('pointerup', endDrag);
    dom.canvas.addEventListener('pointercancel', endDrag);
    dom.canvas.addEventListener('wheel', e => {
      e.preventDefault();
      orbit.dist = clamp(orbit.dist + e.deltaY * 0.0012, 0.55, 2.2);
    }, { passive: false });

    bindHold(document.getElementById('btn-left'), () => { input.left = true; }, () => { input.left = false; });
    bindHold(document.getElementById('btn-right'), () => { input.right = true; }, () => { input.right = false; });
    bindHold(document.getElementById('btn-boost'), () => { input.boost = true; }, () => { input.boost = false; });
    document.getElementById('btn-jump').addEventListener('pointerdown', e => { e.preventDefault(); jump(); });
    document.getElementById('btn-cam').addEventListener('click', cycleCamera);
    document.getElementById('btn-free').addEventListener('click', toggleFreeCam);
    document.getElementById('btn-reset').addEventListener('click', resetOrbit);
    document.getElementById('btn-pause').addEventListener('click', togglePause);
    document.getElementById('btn-start').addEventListener('click', start);
    document.getElementById('btn-restart').addEventListener('click', start);
    document.getElementById('btn-resume').addEventListener('click', togglePause);
  }

  // ============================================================ 主循环
  function update(dt) {
    state.time += dt;
    const playing = state.phase === 'playing';
    const paused = state.phase === 'paused';

    let target;
    if (paused) target = 0;
    else if (!playing) target = 9;
    else {
      // Shift 才加速；空格已经改为跳跃
      state.boost = keys.has('ShiftLeft') || keys.has('ShiftRight') || input.boost;
      const cruise = Math.min(CFG.baseSpeed + state.distance * 0.008, CFG.maxBaseSpeed);
      target = (state.boost && state.energy > 0) ? CFG.boostSpeed : cruise;
    }
    state.speed = damp(state.speed, target, 3.2, dt);
    const dz = state.speed * dt;

    if (playing) {
      if (state.boost && state.energy > 0) state.energy = Math.max(0, state.energy - 24 * dt);
      else state.energy = Math.min(100, state.energy + 9 * dt);
      if (state.energy <= 0) state.boost = false;
      state.distance += dz;
      state.score += dz * 0.8;
      state.comboTimer = Math.max(0, state.comboTimer - dt);
      if (state.comboTimer === 0) state.combo = 0;
      state.invuln = Math.max(0, state.invuln - dt);
    }
    state.shake = Math.max(0, state.shake - dt * 1.8);

    if (!paused) {
      updateWorld(dt, dz);
      updatePlayer(dt);
      updateSpawner(dz);
      updatePickups(coins, dt, dz, collectCoin, 2.6);
      updatePickups(hearts, dt, dz, collectHeart, 1.5);
      updateObstacles(dt, dz);
      updateParticles(dt, dz);
    }
    updateCamera(dt);
    updateHUD(dt);
  }

  function animate() {
    requestAnimationFrame(animate);
    // 上限 0.1s：低帧率设备上宁可少画几帧，也不让游戏变成慢动作
    const dt = Math.min(clock.getDelta(), 0.1);
    if (state.phase !== 'error') update(dt);
    renderer.render(scene, camera);
  }

  function onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, w < 700 ? 1.5 : 1.8));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  // ============================================================ 启动
  function init() {
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: dom.canvas, antialias: true, powerPreference: 'high-performance',
      });
    } catch (e) {
      state.phase = 'error';
      dom.errorMsg.textContent = '当前浏览器无法创建 WebGL 上下文：' + (e && e.message ? e.message : '未知原因');
      dom.error.classList.remove('hidden');
      return;
    }
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xbfe3f2, 70, 260);
    camera = new THREE.PerspectiveCamera(68, 1, 0.1, 1000);
    camera.position.set(2.8, 3.4, 8.6);
    clock = new THREE.Clock();

    scene.add(new THREE.HemisphereLight(0xdff2ff, 0x8fae7a, 2.1));
    const sunLight = new THREE.DirectionalLight(0xfff3d6, 1.9);
    sunLight.position.set(-60, 80, -40);
    scene.add(sunLight);
    const rim = new THREE.DirectionalLight(0x9fd8ff, 0.55);
    rim.position.set(50, 30, 60);
    scene.add(rim);

    buildMaterials();
    world = { chunks: [], clouds: [], gulls: [] };
    buildSky();
    buildSea();
    for (let i = 0; i < CFG.chunkCount; i++) {
      const chunk = makeChunk();
      chunk.group.position.z = -i * CFG.chunkLen;
      world.chunks.push(chunk);
    }
    player = buildPlayer();
    buildPools();

    state.best = readBest();
    dom.best.textContent = state.best.toLocaleString('zh-CN');
    dom.readyBest.textContent = state.best.toLocaleString('zh-CN');
    updateLives();

    setupInput();
    applyCameraVisibility();
    onResize();
    window.addEventListener('resize', onResize);

    // 只读状态 + 少量调试入口，方便手工调参或自动化验证
    window.PelicanRide = {
      get state() {
        return {
          phase: state.phase, score: Math.floor(state.score), coins: state.coins,
          lives: state.lives, energy: Math.round(state.energy), smashes: state.smashes, dodges: state.dodges,
          speedKmh: Math.round(state.speed * 3.6), distance: Math.floor(state.distance),
          jumpY: +player.jumpY.toFixed(2), onGround: player.onGround,
          boost: state.boost, freeCam: state.freeCam,
          camera: CAMERAS[state.cameraIndex].name,
          orbit: { yaw: +orbit.yaw.toFixed(2), pitch: +orbit.pitch.toFixed(2), dist: +orbit.dist.toFixed(2) },
        };
      },
      start, jump, cycleCamera, toggleFreeCam, resetOrbit,
      pause: togglePause,
      spawn(kind, lane = 1, z = -6) {
        const x = CFG.laneX[clamp(Math.round(lane), 0, 2)];
        if (kind === 'coin') spawnCoin(x, z, 1.25);
        else if (kind === 'heart') spawnHeart(x, z, 1.35);
        else if (kind === 'obstacle') spawnObstacle(x, z);
      },
      // 只读诊断：场上还活着的道具位置
      items() {
        const pack = list => list.filter(o => o.active)
          .map(o => ({ x: +o.x.toFixed(2), z: +o.z.toFixed(2), magnet: !!o.magnet }));
        return { coins: pack(coins), hearts: pack(hearts), obstacles: pack(obstacles) };
      },
      // 关闭/开启自然生成，便于隔离测试单个碰撞事件
      setSpawn(on) {
        spawnEnabled = !!on;
        if (on) state.nextSpawn = 14;
      },
      // 清空场上道具，便于隔离测试某一种碰撞
      clear(kind = 'all') {
        const lists = kind === 'coins' ? [coins] : kind === 'hearts' ? [hearts]
          : kind === 'obstacles' ? [obstacles] : [coins, hearts, obstacles];
        for (const list of lists) for (const o of list) {
          o.active = false;
          const m = o.mesh || o.group;
          m.visible = false;
        }
      },
    };

    animate();
  }

  init();
}
