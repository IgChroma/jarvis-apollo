# Imagen del add-on de Jarvis para Home Assistant OS. El Supervisor la construye
# en la Pi (no hay `image:` en config.yaml), con esta carpeta como contexto.
#
# Etapa 1: baja este repo (IgChroma/jarvis-apollo) y, con server/apply.sh, Apollo
# upstream en su commit fijo + el overlay. Después arma apps/agent igual que
# scripts/deploy-server.sh (sin tests, sin devDependencies) y el Dockerfile de
# upstream (bun install --production + tsconfig mínimo de runtime).
# Etapa 2: la misma base de upstream (oven/bun:1.3-slim, multi-arquitectura:
# en la Pi baja la variante arm64) con solo lo necesario para correr.
#
# FROM fijo y no `FROM ${BUILD_FROM}`: un Supervisor viejo sin build.yaml pasa como
# BUILD_FROM la base Alpine de Home Assistant, que no trae bun.
FROM oven/bun:1.3-slim AS build

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Piper (voz local, sin internet) viene DENTRO de la imagen: así el add-on habla
# aunque no haya Azure ni nada en /share. Misma estructura que ~/piper en la Pi con
# Raspberry Pi OS: /opt/piper/piper/piper y /opt/piper/voices/*.onnx.
# Vienen dos voces: la mexicana (rápida) y la argentina (es_AR-daniela-high, mujer,
# 114 MB). La argentina se bajaba al arrancar y nunca terminaba: cada reinicio del
# add-on la cortaba a mitad. Otras voces siguen bajándose solas (ver run.sh).
ARG PIPER_RELEASE=2023.11.14-2
# ruta-en-rhasspy/piper-voices/nombre, separadas por espacios
ARG PIPER_VOICES="es/es_MX/ald/medium/es_MX-ald-medium es/es_AR/daniela/high/es_AR-daniela-high"
RUN set -eu; \
    case "$(uname -m)" in \
      aarch64) piper_arch=aarch64 ;; \
      x86_64) piper_arch=x86_64 ;; \
      *) echo "Piper no tiene binario para $(uname -m)" >&2; exit 1 ;; \
    esac; \
    mkdir -p /opt/piper/voices; \
    curl -fsSL "https://github.com/rhasspy/piper/releases/download/${PIPER_RELEASE}/piper_linux_${piper_arch}.tar.gz" \
      | tar -xz -C /opt/piper; \
    for voice_path in ${PIPER_VOICES}; do \
      voice_name="${voice_path##*/}"; \
      for suffix in .onnx .onnx.json; do \
        curl -fsSL -o "/opt/piper/voices/${voice_name}${suffix}" \
          "https://huggingface.co/rhasspy/piper-voices/resolve/main/${voice_path}${suffix}"; \
      done; \
    done; \
    test -x /opt/piper/piper/piper

# Qué código de Jarvis se usa: repo de GitHub (dueño/nombre) y rama, tag o commit
# completo. El commit de Apollo upstream lo fija server/apply.sh dentro de ese código.
ARG JARVIS_GITHUB=IgChroma/jarvis-apollo
ARG JARVIS_REF=main
# Lo pasa el Supervisor (la `version` de config.yaml); solo va al log.
ARG BUILD_VERSION=dev

WORKDIR /build
# Rompe-caché: Docker compara el CONTENIDO de esta respuesta en cada build, así que
# si la rama avanzó (o cambiaste JARVIS_REF) las capas de abajo se rehacen, y
# "Reconstruir" en Home Assistant trae el código nuevo aunque no cambie la versión.
# Es la API pública de GitHub (60 consultas por hora por IP sin token).
ADD https://api.github.com/repos/${JARVIS_GITHUB}/commits/${JARVIS_REF} /build/jarvis-commit.json

# El sed: server/apply.sh puede venir con CRLF si se commiteó desde Windows antes
# del .gitattributes, y el bash de Linux no tolera los \r.
RUN set -eu; \
    sha="$(bun -e "console.log((await Bun.file('/build/jarvis-commit.json').json()).sha ?? '')")"; \
    if [ -z "$sha" ]; then \
      echo "GitHub no devolvió el commit de ${JARVIS_GITHUB}@${JARVIS_REF}:" >&2; \
      cat /build/jarvis-commit.json >&2; \
      exit 1; \
    fi; \
    echo "Jarvis add-on ${BUILD_VERSION}: ${JARVIS_GITHUB} @ ${JARVIS_REF} = ${sha}"; \
    git init -q jarvis; \
    git -C jarvis fetch -q --depth 1 "https://github.com/${JARVIS_GITHUB}" "$sha"; \
    git -C jarvis checkout -q FETCH_HEAD; \
    sed -i 's/\r$//' jarvis/server/apply.sh; \
    bash jarvis/server/apply.sh /build/apollo

# apps/agent sin node_modules ni tests, y package.json SIN devDependencies: fuera
# del monorepo "@apollo/typescript-config": "workspace:*" no existe y el install falla.
RUN mkdir -p /app \
 && tar -C /build/apollo/apps/agent --exclude node_modules --exclude __tests__ --exclude .dev.vars -cf - . \
    | tar -C /app -xf - \
 && cd /app \
 && bun -e "const p = await Bun.file('package.json').json(); delete p.devDependencies; await Bun.write('package.json', JSON.stringify(p, null, 2) + '\n');" \
 && bun install --production \
 && cp docker/tsconfig.json tsconfig.json

FROM oven/bun:1.3-slim

WORKDIR /app
COPY --from=build /app/package.json /app/tsconfig.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /opt/piper /opt/piper

COPY options-env.mjs /opt/jarvis-addon/options-env.mjs
COPY run.sh /run.sh
RUN sed -i 's/\r$//' /run.sh && chmod 0755 /run.sh

# /data es del Supervisor (ahí escribe options.json): Apollo usa una subcarpeta.
ENV APOLLO_DATA_DIRECTORY=/data/apollo \
    APOLLO_HOST_PORT=8799
EXPOSE 8799

ENTRYPOINT []
CMD ["/run.sh"]
