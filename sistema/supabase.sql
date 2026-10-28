-- =====================================================================
--  SISTEMA DE FIRMAS - Policía de la Provincia de Salta
--  Todo lleva el prefijo firma_ para poder convivir con otros sistemas
--  (por ejemplo Mi Comisaría) en el mismo proyecto de Supabase.
--  Pegar TODO este archivo en Supabase > SQL Editor > New query > Run
--  Se puede volver a ejecutar sin romper nada.
-- =====================================================================

create extension if not exists pgcrypto;

-- Limpieza de un intento anterior de instalación (versión sin prefijo).
-- Solo borra esas tablas si son de este sistema y están vacías.
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='perfiles' and column_name='tiene_firma')
     and exists (select 1 from information_schema.columns where table_schema='public' and table_name='firmas' and column_name='imagen')
     and exists (select 1 from information_schema.columns where table_schema='public' and table_name='firmas_cambios' and column_name='fecha') then
    if not exists (select 1 from public.perfiles) and not exists (select 1 from public.firmas) then
      drop table public.firmas_cambios; drop table public.firmas; drop table public.perfiles;
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. PERFILES (un registro por funcionario)
-- ---------------------------------------------------------------------
create table if not exists public.firma_perfiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text not null,
  nombre       text not null default '',
  apellido     text not null default '',
  jerarquia    text not null default '',
  dependencia  text not null default '',
  legajo       text,
  aprobado     boolean not null default false,  -- lo habilita el administrador
  es_admin     boolean not null default false,
  tiene_firma  boolean not null default false,
  creado       timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. FIRMAS (la imagen de la firma: SOLO la ve su dueño)
-- ---------------------------------------------------------------------
create table if not exists public.firma_imagenes (
  usuario_id   uuid primary key references public.firma_perfiles(id) on delete cascade,
  imagen       text not null,                  -- PNG en base64 (data URL)
  actualizada  timestamptz not null default now()
);

-- Registro de cada vez que alguien crea o cambia su firma
create table if not exists public.firma_cambios (
  id          bigserial primary key,
  usuario_id  uuid not null references public.firma_perfiles(id) on delete cascade,
  fecha       timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 3. SOLICITUDES DE FIRMA
-- ---------------------------------------------------------------------
create table if not exists public.firma_solicitudes (
  id               uuid primary key default gen_random_uuid(),
  codigo           text not null unique default upper(
                     substr(md5(gen_random_uuid()::text),1,4) || '-' ||
                     substr(md5(gen_random_uuid()::text),1,4) || '-' ||
                     substr(md5(gen_random_uuid()::text),1,4)),
  solicitante_id   uuid not null references public.firma_perfiles(id),
  firmante_id      uuid not null references public.firma_perfiles(id),
  tipo_doc         text not null default 'ACTA',
  titulo           text not null,
  mensaje          text,
  origen           text not null check (origen in ('pdf','texto')),
  pdf_original     text not null,               -- ruta en el storage
  hash_original    text not null,               -- SHA-256 del PDF original
  posicion         jsonb not null,              -- dónde va la firma {pagina,x,y,w}
  estado           text not null default 'pendiente'
                     check (estado in ('pendiente','firmada','rechazada','cancelada')),
  motivo           text,                        -- motivo de rechazo
  pdf_firmado      text,
  hash_firmado     text,
  firmante_datos   jsonb,                       -- nombre/jerarquía al momento de firmar
  creada           timestamptz not null default now(),
  resuelta         timestamptz
);
create index if not exists firma_solicitudes_firmante_idx    on public.firma_solicitudes(firmante_id, estado);
create index if not exists firma_solicitudes_solicitante_idx on public.firma_solicitudes(solicitante_id);

-- ---------------------------------------------------------------------
-- 4. FUNCIONES AUXILIARES
-- ---------------------------------------------------------------------
create or replace function public.firma_es_aprobado() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select aprobado from firma_perfiles where id = auth.uid()), false)
$$;

create or replace function public.firma_es_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select es_admin from firma_perfiles where id = auth.uid()), false)
$$;

-- Al registrarse, se crea el perfil con los datos del formulario
create or replace function public.firma_crear_perfil() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.raw_user_meta_data->>'app','') <> 'firmas' and not (new.raw_user_meta_data ? 'jerarquia') then
    return new;   -- cuenta de otro sistema del mismo proyecto: no se toca
  end if;
  insert into firma_perfiles (id, email, nombre, apellido, jerarquia, dependencia, legajo)
  values (
    new.id, new.email,
    upper(coalesce(new.raw_user_meta_data->>'nombre','')),
    upper(coalesce(new.raw_user_meta_data->>'apellido','')),
    upper(coalesce(new.raw_user_meta_data->>'jerarquia','')),
    upper(coalesce(new.raw_user_meta_data->>'dependencia','')),
    upper(nullif(new.raw_user_meta_data->>'legajo',''))
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists firma_al_registrarse on auth.users;
create trigger firma_al_registrarse after insert on auth.users
  for each row execute function public.firma_crear_perfil();

-- Al guardar la firma: marca el perfil y deja registro del cambio
create or replace function public.firma_al_guardar_fn() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.actualizada := now();
  update firma_perfiles set tiene_firma = true where id = new.usuario_id;
  insert into firma_cambios (usuario_id) values (new.usuario_id);
  return new;
end $$;

drop trigger if exists firma_al_guardar on public.firma_imagenes;
create trigger firma_al_guardar before insert or update on public.firma_imagenes
  for each row execute function public.firma_al_guardar_fn();

-- Al crear una solicitud, el código de verificación y la fecha los pone
-- el sistema (no se pueden elegir desde la app)
create or replace function public.firma_nueva_solicitud() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.codigo := upper(substr(md5(gen_random_uuid()::text),1,4) || '-' ||
                      substr(md5(gen_random_uuid()::text),1,4) || '-' ||
                      substr(md5(gen_random_uuid()::text),1,4));
  new.creada := now();
  return new;
end $$;

drop trigger if exists firma_al_crear on public.firma_solicitudes;
create trigger firma_al_crear before insert on public.firma_solicitudes
  for each row execute function public.firma_nueva_solicitud();

-- ---------------------------------------------------------------------
-- 5. SEGURIDAD (Row Level Security)
-- ---------------------------------------------------------------------
alter table public.firma_perfiles       enable row level security;
alter table public.firma_imagenes         enable row level security;
alter table public.firma_cambios enable row level security;
alter table public.firma_solicitudes    enable row level security;

-- PERFILES: cada uno ve el suyo; los aprobados ven a los demás aprobados
drop policy if exists firma_perfiles_ver on public.firma_perfiles;
create policy firma_perfiles_ver on public.firma_perfiles for select to authenticated
  using (id = auth.uid() or (aprobado and public.firma_es_aprobado()) or public.firma_es_admin());

-- Cada uno puede corregir SOLO su jerarquía, dependencia y legajo
-- (nombre, aprobación y rol de admin no se pueden tocar desde la app)
revoke update on public.firma_perfiles from authenticated, anon;
grant update (jerarquia, dependencia, legajo) on public.firma_perfiles to authenticated;
drop policy if exists firma_perfiles_editar on public.firma_perfiles;
create policy firma_perfiles_editar on public.firma_perfiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- FIRMAS: nadie más que el dueño puede ver, crear o cambiar su firma
drop policy if exists firma_imagenes_propia on public.firma_imagenes;
create policy firma_imagenes_propia on public.firma_imagenes for all to authenticated
  using (usuario_id = auth.uid()) with check (usuario_id = auth.uid());

drop policy if exists firma_cambios_ver on public.firma_cambios;
create policy firma_cambios_ver on public.firma_cambios for select to authenticated
  using (usuario_id = auth.uid() or public.firma_es_admin());

-- SOLICITUDES: las ve quien la pidió, a quien se le pidió y el admin
drop policy if exists firma_solicitudes_ver on public.firma_solicitudes;
create policy firma_solicitudes_ver on public.firma_solicitudes for select to authenticated
  using (auth.uid() in (solicitante_id, firmante_id) or public.firma_es_admin());

-- Crear: solo usuarios aprobados, a nombre propio, en estado pendiente,
-- y el firmante también tiene que estar aprobado
drop policy if exists firma_solicitudes_crear on public.firma_solicitudes;
create policy firma_solicitudes_crear on public.firma_solicitudes for insert to authenticated
  with check (
    solicitante_id = auth.uid()
    and public.firma_es_aprobado()
    and estado = 'pendiente'
    and pdf_firmado is null and hash_firmado is null and resuelta is null
    and firmante_datos is null and motivo is null
    and exists (select 1 from public.firma_perfiles p where p.id = firmante_id and p.aprobado)
  );
-- No hay permiso de UPDATE ni DELETE: los cambios de estado se hacen
-- únicamente con las funciones de abajo, que controlan quién puede qué.

-- ---------------------------------------------------------------------
-- 6. ACCIONES
-- ---------------------------------------------------------------------

-- El firmante aprueba. Tiene que mandar el hash del documento que leyó:
-- si no coincide con el original, no se firma.
create or replace function public.firma_aprobar(
  p_id uuid, p_hash_leido text, p_pdf_firmado text, p_hash_firmado text)
returns text
language plpgsql security definer set search_path = public as $$
declare s firma_solicitudes; p firma_perfiles;
begin
  select * into s from firma_solicitudes where id = p_id for update;
  if not found then raise exception 'La solicitud no existe'; end if;
  if s.firmante_id <> auth.uid() then raise exception 'Esta solicitud no es para vos'; end if;
  if s.estado <> 'pendiente' then raise exception 'La solicitud ya fue resuelta'; end if;
  if s.hash_original <> p_hash_leido then raise exception 'El documento no coincide con el original'; end if;
  if p_pdf_firmado not like p_id::text || '/firmado-%.pdf' then raise exception 'Ruta de archivo inválida'; end if;
  select * into p from firma_perfiles where id = auth.uid();
  if not p.aprobado then raise exception 'Tu cuenta no está aprobada'; end if;
  if not p.tiene_firma then raise exception 'Primero tenés que crear tu firma'; end if;
  update firma_solicitudes set
    estado = 'firmada', resuelta = now(),
    pdf_firmado = p_pdf_firmado, hash_firmado = p_hash_firmado,
    firmante_datos = jsonb_build_object(
      'nombre', p.nombre, 'apellido', p.apellido,
      'jerarquia', p.jerarquia, 'dependencia', p.dependencia, 'legajo', p.legajo)
  where id = p_id;
  return s.codigo;
end $$;

create or replace function public.firma_rechazar(p_id uuid, p_motivo text)
returns void
language plpgsql security definer set search_path = public as $$
declare s firma_solicitudes;
begin
  select * into s from firma_solicitudes where id = p_id for update;
  if not found or s.firmante_id <> auth.uid() then raise exception 'Esta solicitud no es para vos'; end if;
  if s.estado <> 'pendiente' then raise exception 'La solicitud ya fue resuelta'; end if;
  update firma_solicitudes set estado = 'rechazada', resuelta = now(),
    motivo = nullif(trim(p_motivo),'') where id = p_id;
end $$;

create or replace function public.firma_cancelar(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare s firma_solicitudes;
begin
  select * into s from firma_solicitudes where id = p_id for update;
  if not found or s.solicitante_id <> auth.uid() then raise exception 'Solo quien pidió la firma puede cancelarla'; end if;
  if s.estado <> 'pendiente' then raise exception 'La solicitud ya fue resuelta'; end if;
  update firma_solicitudes set estado = 'cancelada', resuelta = now() where id = p_id;
end $$;

-- Administrador: aprobar o bloquear cuentas
create or replace function public.firma_admin_aprobar(p_usuario uuid, p_aprobado boolean)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not firma_es_admin() then raise exception 'Solo el administrador puede hacer esto'; end if;
  if p_usuario = auth.uid() and not p_aprobado then raise exception 'No podés bloquear tu propia cuenta'; end if;
  update firma_perfiles set aprobado = p_aprobado where id = p_usuario;
end $$;

-- Verificación pública (la usa la página verificar.html, sin login)
create or replace function public.firma_verificar(p_codigo text)
returns table (
  codigo text, tipo_doc text, titulo text, firmado timestamptz,
  firmante jsonb, solicitante text, hash_firmado text)
language sql stable security definer set search_path = public as $$
  select s.codigo, s.tipo_doc, s.titulo, s.resuelta, s.firmante_datos,
         trim(p.jerarquia || ' ' || p.nombre || ' ' || p.apellido),
         s.hash_firmado
  from firma_solicitudes s join firma_perfiles p on p.id = s.solicitante_id
  where s.codigo = upper(trim(p_codigo)) and s.estado = 'firmada'
$$;

revoke execute on function public.firma_aprobar(uuid,text,text,text) from public, anon;
revoke execute on function public.firma_rechazar(uuid,text) from public, anon;
revoke execute on function public.firma_cancelar(uuid) from public, anon;
revoke execute on function public.firma_admin_aprobar(uuid,boolean) from public, anon;
grant execute on function public.firma_aprobar(uuid,text,text,text) to authenticated;
grant execute on function public.firma_rechazar(uuid,text) to authenticated;
grant execute on function public.firma_cancelar(uuid) to authenticated;
grant execute on function public.firma_admin_aprobar(uuid,boolean) to authenticated;
grant execute on function public.firma_verificar(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 7. ARCHIVOS PDF (bucket privado "firma-actas")
--    firma-actas/<id-solicitud>/original.pdf
--    firma-actas/<id-solicitud>/firmado-<fecha>.pdf
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('firma-actas', 'firma-actas', false)
on conflict (id) do nothing;

drop policy if exists firma_actas_ver on storage.objects;
create policy firma_actas_ver on storage.objects for select to authenticated
  using (bucket_id = 'firma-actas' and exists (
    select 1 from public.firma_solicitudes s
    where s.id::text = (storage.foldername(name))[1]
      and (auth.uid() in (s.solicitante_id, s.firmante_id) or public.firma_es_admin())));

-- Subir el original: solo quien pidió la firma, mientras esté pendiente
drop policy if exists firma_actas_subir_original on storage.objects;
create policy firma_actas_subir_original on storage.objects for insert to authenticated
  with check (bucket_id = 'firma-actas' and exists (
    select 1 from public.firma_solicitudes s
    where s.id::text = (storage.foldername(name))[1]
      and name = s.pdf_original
      and s.solicitante_id = auth.uid()
      and s.estado = 'pendiente'));

-- Subir el firmado: solo el firmante, mientras esté pendiente
drop policy if exists firma_actas_subir_firmado on storage.objects;
create policy firma_actas_subir_firmado on storage.objects for insert to authenticated
  with check (bucket_id = 'firma-actas' and exists (
    select 1 from public.firma_solicitudes s
    where s.id::text = (storage.foldername(name))[1]
      and name like s.id::text || '/firmado-%.pdf'
      and s.firmante_id = auth.uid()
      and s.estado = 'pendiente'));
-- Sin permisos de UPDATE ni DELETE: un PDF subido no se puede reemplazar.

-- ---------------------------------------------------------------------
-- 8. AVISOS EN TIEMPO REAL
-- ---------------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.firma_solicitudes;
exception when duplicate_object then null; when undefined_object then null;
end $$;

-- ---------------------------------------------------------------------
-- 9. CUENTAS CREADAS ANTES DE EJECUTAR ESTE ARCHIVO
--    (les crea el perfil que les falta; no toca los que ya existen
--     ni las cuentas de otros sistemas del mismo proyecto)
-- ---------------------------------------------------------------------
insert into public.firma_perfiles (id, email, nombre, apellido, jerarquia, dependencia, legajo)
select u.id, u.email,
       upper(coalesce(u.raw_user_meta_data->>'nombre','')),
       upper(coalesce(u.raw_user_meta_data->>'apellido','')),
       upper(coalesce(u.raw_user_meta_data->>'jerarquia','')),
       upper(coalesce(u.raw_user_meta_data->>'dependencia','')),
       upper(nullif(u.raw_user_meta_data->>'legajo',''))
from auth.users u
where coalesce(u.raw_user_meta_data->>'app','') = 'firmas' or u.raw_user_meta_data ? 'jerarquia'
on conflict (id) do nothing;
