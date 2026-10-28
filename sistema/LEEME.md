# Sistema de Firmas — Policía de Salta

Cada funcionario tiene su cuenta y su firma. Quien hace un acta le **pide la firma** a su jefe; el jefe la lee y la **aprueba o rechaza** desde donde esté. Todo queda en el historial, con el documento.

- `index.html` — la aplicación
- `nueva-clave.html` — olvidé mi contraseña / elegir contraseña nueva (a donde lleva el enlace del correo)
- `verificar.html` — página pública para comprobar un documento firmado (a la que lleva el QR)
- `supabase.sql` — base de datos y reglas de seguridad
- `config.js` — datos del proyecto de Supabase
- `documento.js` — arma el acta en PDF y estampa la firma

Sitio: https://jr8969662-beep.github.io/facil-firma/sistema/

## Puesta en marcha (una sola vez)

1. **Crear el proyecto en Supabase** (supabase.com → New project, región São Paulo).
2. **Crear la base de datos:** Supabase → *SQL Editor* → *New query* → pegar todo `supabase.sql` → *Run*.
3. **Configurar el acceso:** Supabase → *Authentication* → *URL Configuration* → *Redirect URLs*: agregar
   `https://jr8969662-beep.github.io/facil-firma/sistema/**` (no cambiar el *Site URL* si el proyecto lo comparte Mi Comisaría).
   En *Sign In / Providers → Email* se puede apagar *Confirm email*: las cuentas igual las aprueba el administrador.
   Para que el correo de "Olvidé mi contraseña" llegue a cualquier Gmail hay que configurar un correo propio
   (*Authentication → Emails → SMTP Settings*), porque el correo gratis de Supabase solo envía a los miembros del equipo.
4. **Completar `config.js`** con la *Project URL* y la *anon public key* (Project Settings → API).
5. **Crear tu cuenta** en el sitio (Crear cuenta).
6. **Hacerte administrador:** en el *SQL Editor* ejecutar, con tu correo:
   ```sql
   update public.firma_perfiles set aprobado = true, es_admin = true
   where email = 'TU_CORREO@gmail.com';
   ```
7. Desde **Administración** aprobás a cada funcionario que se registre.

## Cómo funciona

1. El funcionario se registra (nombre, jerarquía, dependencia). El administrador lo aprueba.
2. Dibuja **su firma** una vez. Solo él la puede ver y cambiar, y para cambiarla le pide la contraseña. Cada cambio queda registrado.
3. **Pedir firma:** escribe el acta en el sistema o sube un PDF, elige quién firma y marca dónde va la firma.
4. **El jefe** recibe el pedido, lee el documento completo y lo **aprueba con su contraseña** o lo **rechaza** con un motivo.
5. Al aprobar, se genera el PDF firmado: firma, nombre, jerarquía y dependencia, fecha y hora, código y QR de verificación, y un pie en cada hoja.
6. En **Historial de mi firma** el jefe ve todo lo firmado con su nombre, quién lo pidió y el documento.

## Seguridad

- La imagen de la firma solo la puede leer su dueño. Nadie más puede usarla.
- La firma se aplica solo cuando el firmante aprueba ese documento concreto. El sistema guarda una huella (SHA-256) del original y no deja firmar si el archivo cambió.
- Los PDF no se pueden reemplazar ni borrar una vez subidos.
- Las acciones (aprobar, rechazar, cancelar, habilitar cuentas) pasan por funciones de la base de datos que controlan quién puede hacer qué.

## Alcance legal

Es una **firma electrónica** (Ley 25.506, art. 5): sirve como registro y como prueba de quién aprobó cada documento, pero **no equivale a la firma digital con certificado** (art. 2), que es la que tiene la misma validez que la firma de puño y letra. Para eso se necesita un certificado emitido por una autoridad certificante (por ejemplo, la firma digital remota de firmar.gob.ar).
