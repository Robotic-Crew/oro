# Visualizador 3D de robots (URDF)

Objetivo: un widget de dashboard que muestre el modelo 3D de un robot (p. ej. un brazo) moviéndose
con sus joint states en vivo, que también sirva para replay, y que sea performante aunque haya
varios en la misma página.

Estado: fases 1–5 implementadas (ver [Implementación](#implementación) al final). Pendiente: la
fase 6 y los extras.

## Uso rápido

```yaml
apiVersion: v0.1
kind: RobotModel            # uno por tipo de robot
metadata: { id: demo-arm }
spec:
  label: Demo arm
  urdf: /robot-models/demo-arm/demo_arm.urdf   # http(s) o path del origin de la app
  # packages: { ur_description: https://cdn.example.com/ur_description }  # resuelve package://
  # jointMap: { joint_1: shoulder_pan }        # nombre publicado -> nombre en el URDF
---
apiVersion: v0.1
kind: Robot
metadata: { id: arm-1, scope: "" }
spec:
  label: Arm 1
  model: demo-arm           # cualquier robot; `model: null` lo quita
  ghost: true               # opcional, para demos:
  joints: { shoulder_pan: 0.6, shoulder_lift: -0.4, elbow: 1.2 }   # pose estática (solo ghosts)
```

Después, agregar el widget **3D Model** (`type: robotModel`) a un dashboard de robot.

- **Protocolo:** el agente publica `JointStatesMessage` (`oro.proto`: `ts`, `names[]`,
  `positions[]`) en `r/<robotId>/ros/joint_states`, a su propia frecuencia.
- **Demo en movimiento:** `ingest/scripts/publishJointStates.js <robotId> [--hz 30]` publica un loop
  para el demo arm con las credenciales de ingest.
- **Modelos reales:** `tools/urdf_optimize.py robot.urdf --out app/public/robot-models/<id>
  --package pkg=DIR` (requiere `pip install trimesh pycollada`; `gltfpack` es opcional).

## Decisión

- **Widget en vivo:** Three.js + [`urdf-loader`](https://github.com/gkjohnson/urdf-loaders)
  (opcionalmente con react-three-fiber/drei), con el modelo preconvertido a GLB.
- **Persistencia:** el `TimeSeriesStore` existente (`ingest/src/shared/timeseriesStore.js`). El
  visualizador no guarda nada: solo dibuja.
- **Rerun:** opcional, como herramienta de análisis o replay (exportar una ventana a `.rrd`), no
  como widget ni como dependencia.

### Alternativas descartadas

| Opción | Por qué no |
|---|---|
| Rerun web viewer como widget | El WASM pesa varios MB, hay un contexto GPU por instancia, la UI es egui (no MUI) y necesita un puente MQTT → SDK Rerun → gRPC. |
| ros3djs / roslibjs | Viejo y depende de rosbridge. ORO habla MQTT. |
| Embeber Foxglove | Demasiado pesado para un tile y no se integra visualmente. |
| Babylon.js | Más pesado, con un loader URDF menos maduro. |
| Render en servidor + video | Agrega costo de GPU en servidor, latencia y ancho de banda continuo. No compensa para un asset que se cachea. |

## Arquitectura

```
1 vez por modelo de robot (admin / CI):
  URDF + meshes ──upload──> ORO server ──convierte──> robot.glb + kinematics.json
                                              └──> storage (S3/GCS o GridFS) + CDN

En runtime:
  robot ──MQTT──> ingest ──> TimeSeriesStore (Mongo TS)
                    │                │
                    └─MQTT live──> widget 3D <── consulta histórica (replay)
                                     ▲
                    GET robot.glb ───┘ (CDN, cache inmutable)
```

### Modelo y assets

- **Se sube una vez por cuenta y por modelo de robot**, no por robot ni por usuario. Cada navegador
  descarga el GLB la primera vez y después lo sirve desde cache.
- El cliente nunca ve el URDF original ni los STL/DAE. Pipeline de conversión, que corre una vez:
  1. Descartar los meshes de colisión.
  2. Simplificar los meshes visuales (`gltfpack -si 0.3` o similar). Objetivo: 30–80k triángulos
     por brazo.
  3. Comprimir con meshopt o Draco (suele dar 10–20× menos que DAE/STL).
  4. Generar un solo `.glb` que conserve la jerarquía de links como nodos.
  5. Generar `kinematics.json` con ejes, límites y nombres de joints (unos 2 KB).
  6. Opcional: un thumbnail PNG para usar como placeholder.
- Resolver los URIs `package://` del URDF durante la conversión.
- Servir con un hash en el nombre y `Cache-Control: immutable`.

Tamaño esperado: unos 1–2 MB por modelo en la primera carga (a validar con un URDF real), y
~150–200 KB gzip de three.js + loader, cargados con `import()` dinámico solo si hay un widget 3D.

### configAPI

Es análogo a `robotFootprint.js`, pero en 3D:

- **Kind nuevo `RobotModel`**, uno por tipo de robot: referencia a los assets convertidos,
  ejes y límites de joints, `jointMap` (nombres publicados por el robot → nombres del URDF).
- **`Robot`** solo referencia su modelo (`model: ur5e`). Robots iguales comparten un archivo y una
  entrada de cache.
- Los meshes no van en el YAML. Hay dos caminos:
  1. Un endpoint de upload (`.zip` con URDF + meshes) que convierte y guarda.
  2. Una URL externa a un GLB ya convertido, con un script de conversión en `tools/`.
     **Este es el camino para el PoC.**

### Datos de joints

- **En vivo:** MQTT directo, como `MqttLocalizationDataSources`. Los datos van a un ring buffer y
  en cada `requestAnimationFrame` se interpola y se escribe directo en el nodo del joint. **No pasan
  por Minimongo, `useTracker` ni state de React.**
- Bajar la frecuencia a 15–30 Hz en el origen e interpolar en el cliente.
- **Histórico:** una fuente con la misma interfaz que la de vivo (como el par
  `MeteorLocalizationDataSources` / `MqttLocalizationDataSources`): consulta de `[t0, t1]` al time
  series → buffer → el mismo render, más un slider de tiempo.
- **Almacenamiento:**
  - Histórico bajado a 5–10 Hz.
  - Un campo escalar por joint, para que los `AGG_OPS` y el `TimelineWidget` funcionen sin cambios.
  - TTL de 14 días, como el actual.
  - Opcional: guardar el dato crudo a frecuencia completa en una ventana alrededor de incidentes
    (ring buffer en el ingest que se vuelca cuando salta un incidente).

## Rendimiento: checklist

1. **Render bajo demanda** (`frameloop="demand"` / `invalidate()`): solo cuando llega un dato o el
   usuario mueve la cámara.
2. **Un solo renderer o canvas por página**, con un viewport por widget (scissor o `drei <View>`),
   para evitar el límite de unos 16 contextos WebGL. Hay que diseñarlo así desde el principio.
3. Cache del modelo por tipo de robot, con geometría compartida entre instancias.
4. Decodificar meshopt/Draco fuera del hilo principal (WASM o worker).
5. Pausar el render cuando el widget no está visible (`IntersectionObserver`, `document.hidden`), y
   hacer la carga diferida hasta que entra en pantalla.
6. Llamar a `dispose()` sobre geometrías y materiales al desmontar.
7. Limitar `pixelRatio` a 1.5–2. Iluminación hemisférica + direccional, sin sombras dinámicas.
8. Mostrar un placeholder (thumbnail o esqueleto) mientras carga.

## Extras posteriores

- Pose objetivo o trayectoria planeada como fantasma semitransparente.
- Colorear los joints cerca de su límite.
- Activar o desactivar los frames TF y el workspace del brazo.
- Exportar una ventana del time series a `.rrd` para analizarla en Rerun.

## Plan por fases

1. **PoC:** widget en `app/imports/client/oro/robotWidgets/` con `urdf-loader` y render bajo
   demanda, alimentado con joint states sintéticos (un script en `tools/` que publique por MQTT).
   Ojo: los ghost robots actuales escriben su estado una sola vez y son estáticos, así que para
   animar hace falta ese publicador o extender los ghosts. Validar UX y FPS.
2. **Assets:** conversión URDF → GLB (script en `tools/`), kind `RobotModel` y referencia desde
   `Robot`. Medir los tamaños reales antes y después con el brazo objetivo (¿UR5e?).
3. **Datos reales:** módulo de joint states en el ingest, suscripción MQTT en el widget y
   persistencia en el time series.
4. **Replay:** fuente histórica + slider, e integración con `IncidentTimeline`.
5. **Escala:** canvas compartido con viewports para varios widgets 3D por página.
6. **Opcional:** endpoint de upload con conversión automática y export a `.rrd`.

## Preguntas abiertas

- ¿Qué brazo se muestra primero?
- ¿Los joint states ya llegan por MQTT o hay que agregarlos al ingest?
- ¿Joint states como atributo normal del ingest (y por lo tanto visibles en `TimelineWidget`) o como
  un módulo aparte tipo `ingest/src/server/modules/localization.js`?
- ¿Dónde se guardan los assets: bucket/CDN o GridFS?

## Implementación

| Pieza | Dónde |
|---|---|
| Mensaje `JointStatesMessage` | `app/private/oro.proto` (+ copia en `app/public/`; ingest la copia con `import.sh`) |
| Ingest: snapshot + time series, 5 Hz por defecto | `ingest/src/server/modules/jointStates.js` (settings: `modules.jointStates.persistIntervalMs`, `timeseriesEnabled`) |
| Kind `RobotModel`; `Robot.spec.model` y `joints` (ghosts) | `app/imports/server/configAPI/robotModel.js`, `robots.js` |
| Publicaciones `robot_models.forRobot`, `joint_states`; método `jointStates.history` | `app/imports/server/jointStates.js` |
| `TimeSeriesStore.rawQuery` y `jointFieldName` (`joint_<nombre>`) | `app/imports/shared/timeseriesStore.js` |
| Widget (contenedor, fuentes de joints, interpolación) | `app/imports/client/oro/robotWidgets/RobotModelWidget/` |
| three.js (chunk lazy): vista, renderer compartido, cache de modelos | `RobotModelView.js`, `three/sceneHost.js`, `three/modelCache.js` |
| Demo arm (primitivas, sin meshes) | `app/public/robot-models/demo-arm/demo_arm.urdf` |
| Conversión de meshes | `tools/urdf_optimize.py` |

Diferencias con el plan original:

- **Assets:** en vez de un único GLB más `kinematics.json`, el resultado es el URDF original (sin
  `<collision>`) más un GLB comprimido por mesh. El XML pesa unos KB y `urdf-loader` lo parsea
  directo, lo que evita mantener un formato propio de cinemática. Con `gltfpack`, en una prueba
  sintética los meshes pasaron de 1 MB de STL a 24 KB.
- **Renderer compartido:** hay un solo `WebGLRenderer` offscreen, y cada widget tiene un canvas 2D
  al que se copia su imagen (`drawImage`). Así se evita el límite de contextos y los problemas de
  z-order de un canvas superpuesto a la página.
- **Replay:** usa el rango de tiempo del dashboard, con un máximo de 24 h y 20k puntos (~1 h a 5 Hz),
  y el slider cubre solo el tramo que tiene datos.
- **Ghost robots y MQTT en vivo:** el browser obtiene el broker de un robot a partir de la
  credencial MQTT de su agente, y un ghost no tiene una (limitación previa de
  `mqttCredentialProvisioner`). Por eso, para un ghost, el widget anima con el snapshot de ingest
  (5 Hz, interpolado) y no con MQTT directo.

Pendiente: endpoint de upload con conversión automática, integración con `IncidentTimeline`,
export a `.rrd`, y los extras (pose objetivo, colores por límite, frames TF).
