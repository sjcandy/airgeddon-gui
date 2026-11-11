# Contribuir a airgeddon GUI

Gracias por tu interés en contribuir. Este documento describe cómo participar en el proyecto.

## Código de conducta

Este proyecto se adhiere al [Código de Conducta](CODE_OF_CONDUCT.md). Al participar, te comprometes a mantener
un ambiente respetuoso y constructivo. No se tolera el acoso, la discriminación ni el
comportamiento ofensivo.

## Cómo contribuir

### Reportar bugs

1. Busca en los [Issues existentes](https://github.com/sjcandy/airgeddon-gui/issues) para
   que el bug no haya sido reportado.
2. Abre un nuevo Issue con:
   - Descripción clara del problema
   - Pasos para reproducirlo
   - Comportamiento esperado vs. observado
   - Versión de Node.js, distribución Linux y versión de airgeddon
   - Capturas de pantalla si aplica
   - **Cuidado**: no incluyas contraseñas, ESSID/MAC reales ni rutas con tu nombre de usuario.

### Sugerir mejoras

Abre un Issue con la etiqueta `enhancement` describiendo:
- El problema que resuelve
- La solución propuesta
- Alternativas consideradas

### Enviar Pull Requests

1. **Fork** el repositorio
2. Crea una rama desde `main`:
   ```bash
   git checkout -b feature/mi-mejora
   ```
3. Realiza tus cambios siguiendo las convenciones del proyecto
4. Ejecuta las pruebas:
   ```bash
   npm test
   npm run lint
   ```
5. Commit con mensajes descriptivos (ver convención abajo)
6. Push a tu fork y abre un Pull Request

### Convención de commits

Usamos [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: agregar nueva funcionalidad
fix: corregir un bug
docs: cambios en documentación
style: cambios de formato (sin cambios de lógica)
refactor: refactorización de código
test: agregar o modificar pruebas
chore: tareas de mantenimiento
```

Ejemplos:
```
feat: agregar vista de tarjetas para redes
fix: corregir error de hover en botones superiores
docs: actualizar README con instrucciones de Docker
```

### Estilo de código

- **JavaScript**: ES6+, `'use strict'` en todos los archivos, 2 espacios de indentación
- **CSS**: Variables CSS para temas, 2 espacios de indentación
- **HTML**: Semántico, con atributos ARIA
- **Nombres**: camelCase para JS, kebab-case para CSS classes
- **Comentarios**: En español, descriptivos

### Estructura del proyecto

```
airgeddon-gui/
├── server.js              # Backend: HTTP, WebSocket, PTY, escaneo
├── public/                # Frontend estático
│   ├── index.html         # Shell de la aplicación
│   ├── css/app.css        # Estilos y temas
│   ├── js/                # Módulos JavaScript
│   └── sw.js              # Service Worker (PWA)
├── test/                  # Pruebas
├── docs/                  # Capturas de pantalla
├── install.sh             # Instalador interactivo
├── install-desktop.sh     # Integración con el menú de aplicaciones
├── build-deb.sh           # Empaquetado .deb
├── PKGBUILD               # Empaquetado Arch
├── package.json           # Dependencias y scripts
└── README.md              # Documentación
```

### Pruebas

```bash
# Pruebas del parser
npm test

# Verificación de sintaxis de server.js y de todos los módulos del cliente
npm run lint

# Prueba manual
npm start
# Abrir http://127.0.0.1:3845
```

### Alcance del proyecto

airgeddon-gui es un **front-end independiente** de airgeddon. El proyecto **no** modifica airgeddon ni incluye su
código fuente: se comunica con él a través de una pseudo-terminal, igual que lo haría una persona. Si tu
contribución toca la lógica de auditoría en sí, pertenece probablemente al
[repositorio original de airgeddon](https://github.com/v1s1t0r1sh3r3/airgeddon).

### Licencia

Al contribuir, aceptas que tus contribuciones se licencien bajo la [Licencia MIT](LICENSE).
"