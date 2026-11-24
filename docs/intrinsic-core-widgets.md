# Intrinsic Core en ORO: qué mostrar

Información que expone (o puede exponer) una celda con [Intrinsic Core](https://github.com/intrinsic-ai/intrinsic-core)
y que ORO no sabía mostrar. Surge de comparar los widgets de ORO con una celda de pick and place:
un brazo de 6 ejes con gripper y cámara de profundidad en la muñeca, árboles `grab` / `release` /
`full`, y un connector InOrbit que solo publica key-values y el código de salida de cada paso.

Estado: **1, 2 y 3 implementados** (ver [Implementado](#implementado)); el resto es backlog.

## Lo que falta, por prioridad

### 1. Ejecución del Behavior Tree
Lo propio de Core: la celda ejecuta árboles de skills. ORO solo veía un resumen (`cell_state`,
`grab_failed`).
- **Widget Execution:** el árbol con el nodo en curso resaltado y el estado de cada nodo (running /
  ok / failed), en qué nodo falló y el error (p. ej. `GrabFailed` en el `grasp_check`).
- **Timeline de pasos por ciclo (Gantt):** standby, ir a mirar, capturar, estimar pose, bajar,
  cerrar, check, levantar, esperar al AMR, cada uno con su duración. Muestra dónde se va el
  tiempo del ciclo.
- Faltaba en ORO un timeline **categórico** (bandas por estado): el `TimelineWidget` solo grafica
  números. También sirve para AMRs (misión / cargando / idle).
- Fuente de datos: el *executive* de Core (gRPC). Un connector que solo ve el código de salida del
  proceso principal no alcanza: hay que leer el estado del executive y publicarlo.

### 2. Escena 3D completa
El widget 3D mostraba solo el brazo (URDF + joints).
- Objetos de la escena: mesa, jaula, rampa, carritos, AMR, soporte de la cámara.
- Frames: TCP, `lane_*_view`, `lane_*_grasp`, drop, destinos de `go_to`.
- Objeto adjunto: la pieza en el gripper después de "Adjuntar pieza al gripper", y dónde quedó al
  soltarla.
- Trayectoria planificada: el camino del TCP antes y durante el movimiento.
- Fuente: el world/scene de Core (`scene.updates.pbtxt`, `cell.yaml`) y el planner.

### 3. Percepción
El widget de cámara de ORO muestra la imagen en vivo, sin más.
- Overlay sobre la imagen de la cámara: bounding box de la detección (RF-DETR) y ejes de la pose
  6-DoF estimada (FoundationPose).
- Confianza de la estimación, por intento, con historial.
- Snapshot por intento de agarre, asociado al ciclo (y al incidente).
- Pendiente: profundidad / nube de puntos desde la pose de observación (clave sobre superficies
  reflectivas, como el acero inoxidable).

### 4. Barra de control del brazo
`RobotControlBar` y el teleop de ORO son de navegación (AMRs). Para un brazo:
- Estado operacional de ICON: enabled, faulted, e-stop, parada protectiva, modo sim o real.
- Override de velocidad (%) como slider; el feed hold usa override 0.
- Pause / Resume / Stop, Clear faults, Enable, `reset_cell`, con confirmación y habilitados según
  el estado (como la tabla "Permitido en" del connector).
- Qué connector tiene el brazo (ROS, PLC o Intrinsic): el controlador acepta una sola sesión RPC.

### 5. Panel de joints y fuerzas
- Por joint: posición contra límites (barra), velocidad, torque medido contra deseado y % del
  nominal, resaltado cerca del límite.
- Pose cartesiana del TCP (x, y, z, rpy) y gripper (% de cierre, agarre detectado, fault).
- Hoy se puede armar con key-values y charts, pero sin el contexto de límites.

### 6. KPIs de celda por causa
El time series agrega números en el tiempo, pero no desglosa por categoría.
- Resultados (`ok`, `grab_failed`, `piece_not_found`, `amr_timeout`, `error`) por carril y turno.
- Distribución del tiempo de ciclo (p50 / p95), tasa de éxito de la visión.
- Espera en el handshake con el AMR (brazo en `at_drop_waiting` vs. AMR esperando al brazo).

### 7. Salud del runtime de Intrinsic
El widget de diagnostics espera diagnósticos ROS.
- Servicios y pods de k3s (ICON, executive, perception, inference, Zenoh), uso de GPU, versión de
  la solución desplegada (tag, rama).
- Calidad del lazo de ICON: jitter y ciclos perdidos a 125 Hz.
- Calibración: fecha, error de reproyección y pose de la cámara; alerta si se degrada.

## Resumen

| Información de Core | ORO antes | Qué hacía falta |
|---|---|---|
| BT / skills en ejecución | No | Widget Execution + timeline categórico |
| Escena, frames, objeto adjunto, plan | Solo URDF | Escena 3D + datos de escena |
| Percepción (bbox, pose, confianza, depth) | Imagen sola | Overlays + capturas por evento |
| Estado ICON + override + faults | Acciones sueltas | Barra de control del brazo |
| Joints, torques, TCP | Números sueltos | Panel de joints con límites |
| Resultados de ciclo por causa | Series numéricas | Widget de KPIs categóricos |
| Salud k3s, lazo de ICON, calibración | Diagnostics ROS | Mapeo de servicios y métricas |

## Otras ideas de integración

- ORO compatible con el `inorbit-connector` (edge SDK): verificar que ORO sirva el endpoint de
  configuración que usa el SDK; si falta, cualquier connector basado en él entraría sin cambios.
- El brazo en el widget 3D: que el connector publique `JointStatesMessage` (radianes, a la
  frecuencia de Zenoh), o que `RobotModel` acepte un mapeo desde key-values (`joint_N_pos` en grados).
- Modelos de fabricante (URDF con meshes pesados) pasados por `tools/urdf_optimize.py`.
- Incidentes (`grab_failed`, `piece_not_found`, `error`, `emergency_stop`) con replay de joints,
  foto y pieza detectada.
- Regresión nocturna: ciclos simulados de la celda como un robot más en ORO.
- Historial de calibración con alerta.

## Implementado

Datos: el agente (o el connector) publica tres mensajes por MQTT; ingest los guarda y la app los
publica a los widgets. Sin agente, `ingest/scripts/demoIntrinsicCell.js` simula una celda que hace
ciclos de pick y publica por MQTT lo mismo que un agente real (con las credenciales de ingest, así
que sirve para un robot ghost).

| Topic (`r/<robotId>/...`) | Mensaje (`oro.proto`) | Colección |
|---|---|---|
| `intrinsic/execution` | `ExecutionStateMessage` (árbol, estado por nodo, ciclo, error) | `executions` (último por robot), `execution_steps` (un doc por paso terminado) |
| `intrinsic/scene` | `SceneMessage` (objetos, frames, objetos adjuntos, camino planificado) | `scenes` (último por robot) |
| `intrinsic/perception` | `PerceptionResultMessage` (imagen, detecciones, pose 2D/3D, confianza) | `perception_results` (últimos 50 por robot) |

Widgets nuevos (dashboards de robot):
- **Execution** (`execution`): árbol con estado por nodo, estado del ciclo y error.
- **Cycle Timeline** (`cycleTimeline`): Gantt de los últimos ciclos, un color por paso, con el
  resultado de cada ciclo.
- **Perception** (`perception`): última captura con overlays (bounding box, ejes de la pose),
  confianza, e historial de capturas.
- **3D Model** (`robotModel`): ahora también dibuja la escena, los frames, el objeto adjunto y el
  camino planificado (se pueden ocultar desde el widget).

Demo:

```bash
cd ingest && node scripts/demoIntrinsicCell.js --robot cell-1   # con la app, el broker e ingest corriendo
```

Crea (si no existen) el modelo `demo-arm`, el robot ghost `cell-1` y el dashboard **Intrinsic Cell**,
y queda corriendo ciclos de pick sobre dos carriles (con un agarre fallido de vez en cuando). Además
del estado online, las joints, la ejecución, la escena y la percepción, publica un resumen de la
celda como key-values (`cell_state`, `current_step`, `last_cycle_result`, `cycles_ok`, ...): es lo
que se ve en un dashboard sin estos widgets, p. ej. en InOrbit con upstream forwarding.
