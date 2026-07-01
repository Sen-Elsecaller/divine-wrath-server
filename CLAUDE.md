# Divine Wrath — Server

## Qué es

Backend Socket.io del juego: dueño de todo el estado real de cada sala (`room`), lógica de turnos/fases/puntaje, y el relayer que manda proofs a la blockchain cuando el modo ZK está activo.

Uno de 3 repos hermanos clonados juntos en `divine-wrath/` (no es repo git). **`divine-wrath-contracts/docs/CLAUDE.md` es el hub de contexto compartido** (reglas de trabajo, arquitectura completa de los 3 repos, gotchas, bitácora de sesiones) — leerlo antes de asumir algo que cruce las 3 capas. El frontend correspondiente es [`divine-wrath-frontend`](https://github.com/Sen-Elsecaller/divine-wrath-frontend).

## Stack y comandos

- Node.js (ES Modules) + Express + Socket.io + `@stellar/stellar-sdk`.
- `npm install && npm start` (o `npm run dev` con `--watch`) → puerto `3001` (`PORT` en `.env`).
- Sin tests automatizados — `test-relayer.js` es un script manual para probar el relayer directo, no un test runner.
- Sin linter configurado.

## Arquitectura

Todo el server vive en un solo archivo, **`index.js`** (~1000 líneas): crea/gestiona salas en memoria (`Map` de `roomCode → room`), maneja los eventos de socket (`create_room`, `join_room`, `select_position`, `submit_claim`, `verify_claim`, `attack_cell`, `god_choice`, etc.) y decide las reglas del juego — turnos, fases, puntaje, quién gana. El `room` que emite es el mismo shape que consume el frontend (`Room` en `shared/types.ts`, debería estar espejado con `divine-wrath-frontend/src/shared/types.ts` — confirmar que coincidan antes de asumir un campo).

`shared/constants.js` y `shared/types.ts` están para mantenerse en paralelo a los del frontend (`CLAIM_TYPES`, `PHASES`, `ROLES`, `ADJACENCY_MAP`, `POINTS`, `MAX_CONSECUTIVE_GOD_ROUNDS`, etc.) — si cambia una regla de negocio en un lado, hay que replicarla en el otro a mano, no hay un paquete compartido entre ambos repos.

### Flujo de verificación de claims

- **Modo Simple (default, `room.zkEnabled = false`)**: `verify_claim` compara el claim contra la posición real guardada en memoria del server. Inmediato, sin ZK.
- **Modo ZK (`room.zkEnabled = true`)**: el handler de `verify_claim` (`index.js`) llama `submitClaimRelayed` (`relayer.js`) cuando el claim trae `zkProof` adjunto — firma con la cuenta admin (`DIVINE_WRATH_ADMIN_SECRET`) y llama al contrato Soroban `divine-wrath`, que corre el verifier Groth16 on-chain en Testnet.
- `effectiveZkEnabled = zkEnabled && RELAYER_CONFIGURED` — si no hay `DIVINE_WRATH_ADMIN_SECRET` configurado, el modo ZK se ignora aunque el host lo pida.

**Patrón relayer**: `relayer.js` firma todas las transacciones on-chain con la cuenta admin — los jugadores nunca necesitan wallet propia. `generatePlayerAddressSync` genera direcciones determinísticas por jugador (hash de `roomCode + playerId`) solo para identificarlos en el contrato, no son wallets reales.

> **ZK Mode en pausa desde 2026-07-01** (ver hub) — el contrato on-chain solo soporta una partida entre 2 direcciones a la vez, límite específico del hackathon. Funciona, pero no se espera mantenerlo activamente ni extenderlo salvo pedido explícito.

## Variables de entorno

Ver `.env.example`. Con `USE_BLOCKCHAIN=false` (o sin `DIVINE_WRATH_ADMIN_SECRET`) el server corre igual, solo que el modo ZK queda deshabilitado.

## Reglas para Claude

1. **Nunca push sin preguntar** — siempre mostrar el commit message y esperar aprobación.
2. **Preguntar antes de asumir** — ante cualquier duda sobre una regla de juego o sobre si algo del relayer sigue vigente.
3. **Fragmentar el trabajo** — cambios pequeños, uno a la vez.
4. **Si se toca una regla de negocio compartida** (puntaje, fases, límites), revisar que `divine-wrath-frontend/src/shared/` quede consistente con `shared/` de este repo — no hay tipo compartido entre ambos repos, hay que sincronizar a mano.
5. **Estilo de código** — mantener el estilo del archivo (JS, no TS en `index.js`/`relayer.js`); no alinear columnas con espacios extra ni comprimir statements en una línea.
6. **ZK Mode está en pausa** — no invertir tiempo extendiendo `relayer.js` ni la integración Soroban salvo pedido explícito del usuario.

## Ver también

- `../divine-wrath-contracts/docs/CLAUDE.md` — hub de los 3 repos
- `../divine-wrath-contracts/docs/bitacora.md` — historial de sesiones
- `../divine-wrath-frontend/CLAUDE.md` — contraparte de UI
