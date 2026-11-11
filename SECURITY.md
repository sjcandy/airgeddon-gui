# Política de Seguridad

## Versiones soportadas

| Versión | Soportada |
| :--- | :---: |
| 2.0.x | ✅ |
| < 2.0 | ❌ |

## Cómo reportar una vulnerabilidad

**No abras un Issue público** para reportar un fallo de seguridad. En su lugar, usa el reporte privado de
GitHub:

> https://github.com/sjcandy/airgeddon-gui/security/advisories/new

Incluye:

- Descripción del problema y su impacto.
- Pasos para reproducirlo.
- Versión de airgeddon-gui, Node.js y distribución Linux.
- Cualquier captura o log **anonimizado** (sin ESSID, MAC, contraseñas ni rutas con tu nombre de usuario).

Recibirás una respuesta inicial en un plazo de 7 días. Confirmaremos la recepción, investigaremos el reporte y
te informaremos cuando se publique una corrección.

## Modelo de seguridad del proyecto

airgeddon-gui gestiona privilegios de `sudo` y expone una API HTTP local. Estas son las decisiones de diseño
relevantes para evaluar el riesgo:

| Aspecto | Comportamiento |
| :--- | :--- |
| **Bind del servidor** | Exclusivamente `127.0.0.1:3845`. No es accesible desde la red local. |
| **Credenciales de sudo** | Viven únicamente en la memoria RAM del proceso. Nunca se escriben en disco ni en logs. Se enmascaran (`••••••`) en la salida de la terminal. |
| **Gestor de contraseñas del navegador** | Desactivado en el perfil dedicado que usa el modo aplicación. |
| **CSP** | `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `connect-src 'self' ws: wss:`. |
| **Validación de entrada** | Los nombres de interfaz se validan contra `^[a-zA-Z0-9_.:-]+$` antes de interpolarlos en comandos. Los comandos se ejecutan con `spawn`/`execFile` (sin shell). |
| **Carga del `.airgeddonrc`** | Escritura limitada a 200 KB. |

### Limitaciones conocidas

- **La API REST no tiene token de sesión.** Cualquier proceso local, o una página web maliciosa que consiga
  alcanzar `http://127.0.0.1:3845` (por ejemplo vía CSRF, dado que no se valida el encabezado `Origin`), podría
  invocar endpoints como `POST /api/auth`, `POST /api/interfaces/kill` o `POST /api/system/updates/apply`.
- **`POST /api/system/updates/apply`** ejecuta `git pull --rebase` y `npm install --production` sobre el
  directorio de instalación. Revisa siempre el diff del repositorio antes de aplicarlo.
- **`sudo -k`**: cada comando privilegiado invalida la caché de credenciales de `sudo` del sistema.
- **`POST /api/config/raw`** permite escribir el `.airgeddonrc` completo, que es el archivo de configuración que
  airgeddon ejecuta.

Estos puntos están documentados de forma consciente, no son defectos ocultos. Si quieres minimizar la superficie
de ataque, ejecuta la aplicación solo cuando la necesites y cierra el proceso al terminar.

## Alcance

Este proyecto es una herramienta de auditoría de seguridad. **Las vulnerabilidades que solo puedan explotarse
contra redes de terceros sin autorización no se consideran vulnerabilities de este proyecto**, sino un uso
incorrecto de la herramienta.
