/**
 * Divine Wrath Relayer
 *
 * Módulo para enviar claims con ZK proofs al contrato on-chain.
 * Usa la cuenta admin como relayer para que los mortales no necesiten wallet.
 */

import {
  Keypair,
  Contract,
  TransactionBuilder,
  Networks,
  rpc,
  xdr,
  Address,
  nativeToScVal,
} from '@stellar/stellar-sdk';

// ============================================================================
// Configuration
// ============================================================================

const RPC_URL = process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = Networks.TESTNET;
const CONTRACT_ID = process.env.DIVINE_WRATH_CONTRACT_ID || 'CC3D5AH5B3DOGZPJIX2T52PIT3Q2Y6XT3XIAG2FYCK32SBVENIXJFYQZ';

// Admin secret key (from stellar keys show divine-wrath-admin)
// In production, use environment variable
const ADMIN_SECRET = process.env.DIVINE_WRATH_ADMIN_SECRET;

// ============================================================================
// Proof Conversion Utilities
// ============================================================================

/**
 * Convierte un número decimal (string) a bytes big-endian de 32 bytes
 */
function decimalToBytes32(decimal) {
  const bytes = new Uint8Array(32);
  let num = BigInt(decimal);

  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(num & 0xFFn);
    num >>= 8n;
  }

  return bytes;
}

/**
 * Convierte un punto G1 de snarkjs a 64 bytes
 */
function g1PointToBytes(point) {
  const x = decimalToBytes32(point[0]);
  const y = decimalToBytes32(point[1]);

  const result = new Uint8Array(64);
  result.set(x, 0);
  result.set(y, 32);

  return Buffer.from(result);
}

/**
 * Convierte un punto G2 de snarkjs a 128 bytes
 * Soroban usa ordenamiento imag||real
 */
function g2PointToBytes(point) {
  const xReal = decimalToBytes32(point[0][0]);
  const xImag = decimalToBytes32(point[0][1]);
  const yReal = decimalToBytes32(point[1][0]);
  const yImag = decimalToBytes32(point[1][1]);

  const result = new Uint8Array(128);
  result.set(xImag, 0);   // x.c1 (imag)
  result.set(xReal, 32);  // x.c0 (real)
  result.set(yImag, 64);  // y.c1 (imag)
  result.set(yReal, 96);  // y.c0 (real)

  return Buffer.from(result);
}

/**
 * Convierte un proof de snarkjs al formato del contrato
 */
export function convertSnarkjsProofToContract(proof) {
  return {
    a: g1PointToBytes(proof.pi_a),
    b: g2PointToBytes(proof.pi_b),
    c: g1PointToBytes(proof.pi_c),
  };
}

// ============================================================================
// Contract Interaction
// ============================================================================

/**
 * Crea el ScVal para un Groth16Proof
 */
function proofToScVal(proof) {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('a'),
      val: xdr.ScVal.scvBytes(proof.a),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('b'),
      val: xdr.ScVal.scvBytes(proof.b),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('c'),
      val: xdr.ScVal.scvBytes(proof.c),
    }),
  ]);
}

/**
 * Envía un claim al contrato usando el relayer
 *
 * @param {number} sessionId - ID de la partida
 * @param {string} mortalAddress - Dirección del mortal (Stellar address)
 * @param {number} claimType - 0=row, 1=column, 2=adjacent
 * @param {number} claimValue - Valor del claim
 * @param {boolean} expectedResult - true/false
 * @param {object} snarkjsProof - Proof de snarkjs {pi_a, pi_b, pi_c}
 * @returns {Promise<boolean>} - Resultado del claim
 */
export async function submitClaimRelayed(
  sessionId,
  mortalAddress,
  claimType,
  claimValue,
  expectedResult,
  snarkjsProof
) {
  if (!ADMIN_SECRET) {
    throw new Error('DIVINE_WRATH_ADMIN_SECRET not set. Cannot use relayer.');
  }

  const adminKeypair = Keypair.fromSecret(ADMIN_SECRET);
  const server = new rpc.Server(RPC_URL);

  // Convertir proof al formato del contrato
  const proof = convertSnarkjsProofToContract(snarkjsProof);

  // Crear contrato y operación
  const contract = new Contract(CONTRACT_ID);
  const operation = contract.call(
    'submit_claim_relayed',
    nativeToScVal(sessionId, { type: 'u32' }),
    new Address(mortalAddress).toScVal(),
    nativeToScVal(claimType, { type: 'u32' }),
    nativeToScVal(claimValue, { type: 'u32' }),
    nativeToScVal(expectedResult, { type: 'bool' }),
    proofToScVal(proof)
  );

  // Construir transacción
  const account = await server.getAccount(adminKeypair.publicKey());
  const transaction = new TransactionBuilder(account, {
    fee: '100000', // 0.01 XLM
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();

  // Simular
  const simulated = await server.simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulated)) {
    console.error('[Relayer] Simulation error:', simulated.error);
    throw new Error(`Simulation failed: ${simulated.error}`);
  }

  // Preparar y firmar
  const prepared = rpc.assembleTransaction(transaction, simulated).build();
  prepared.sign(adminKeypair);

  // Enviar
  const result = await server.sendTransaction(prepared);
  console.log('[Relayer] Transaction sent:', result.hash);

  // Esperar confirmación
  if (result.status === 'PENDING') {
    let txResult = await server.getTransaction(result.hash);
    while (txResult.status === 'NOT_FOUND') {
      await new Promise(resolve => setTimeout(resolve, 1000));
      txResult = await server.getTransaction(result.hash);
    }

    if (txResult.status === 'SUCCESS') {
      console.log('[Relayer] Transaction successful');
      // Extraer resultado
      const returnValue = txResult.returnValue;
      if (returnValue) {
        // El resultado es Ok(bool) o Err(Error)
        const resultType = returnValue.switch().name;
        if (resultType === 'scvVoid') {
          return expectedResult;
        }
        // Intentar extraer el valor
        try {
          const val = returnValue.value();
          if (typeof val === 'boolean') return val;
          if (val && typeof val.value === 'function') {
            return val.value();
          }
        } catch (e) {
          console.log('[Relayer] Could not extract result, assuming success');
          return expectedResult;
        }
      }
      return expectedResult;
    } else {
      console.error('[Relayer] Transaction failed:', txResult);
      throw new Error(`Transaction failed: ${txResult.status}`);
    }
  }

  throw new Error(`Unexpected transaction status: ${result.status}`);
}

/**
 * Verifica si el relayer está configurado correctamente
 */
export function isRelayerConfigured() {
  return !!ADMIN_SECRET;
}

/**
 * Obtiene la dirección del admin (relayer)
 */
export function getRelayerAddress() {
  if (!ADMIN_SECRET) return null;
  return Keypair.fromSecret(ADMIN_SECRET).publicKey();
}

// ============================================================================
// Claim Type Mapping
// ============================================================================

export const CLAIM_TYPES = {
  row: 0,
  column: 1,
  adjacent: 2,
};

export function claimTypeToNumber(claimType) {
  return CLAIM_TYPES[claimType] ?? -1;
}

// ============================================================================
// Start Game
// ============================================================================

/**
 * Genera una dirección determinística para un jugador basada en room code y player id
 * Esto permite que los jugadores sin wallet tengan una "dirección" única en blockchain
 */
export function generatePlayerAddressSync(roomCode, playerId) {
  // Para simplificar, usamos el admin como base y creamos direcciones derivadas
  // Esto es un placeholder - en producción se usaría un esquema más robusto
  if (!ADMIN_SECRET) {
    throw new Error('DIVINE_WRATH_ADMIN_SECRET not set');
  }

  // Usar hash simple para crear seed
  const seed = `${roomCode}-${playerId}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }

  // Crear seed de 32 bytes
  const seedBuffer = new Uint8Array(32);
  const view = new DataView(seedBuffer.buffer);
  view.setInt32(0, hash);
  view.setInt32(4, hash ^ 0x12345678);
  view.setInt32(8, hash ^ 0x87654321);
  view.setInt32(12, hash ^ 0xDEADBEEF);
  // Repetir para llenar
  for (let i = 16; i < 32; i++) {
    seedBuffer[i] = seedBuffer[i - 16] ^ (i * 17);
  }

  const keypair = Keypair.fromRawEd25519Seed(seedBuffer);
  return keypair.publicKey();
}

/**
 * Inicia una partida en blockchain usando el relayer
 *
 * @param {number} sessionId - ID de la partida (derivado del room code)
 * @param {string} roomCode - Código de la sala
 * @param {string} godPlayerId - ID del jugador God
 * @param {string[]} mortalPlayerIds - IDs de los jugadores Mortales
 * @returns {Promise<void>}
 */
export async function startGameRelayed(sessionId, roomCode, godPlayerId, mortalPlayerIds) {
  if (!ADMIN_SECRET) {
    throw new Error('DIVINE_WRATH_ADMIN_SECRET not set. Cannot use relayer.');
  }

  if (mortalPlayerIds.length !== 3) {
    throw new Error('Exactly 3 mortals required');
  }

  const adminKeypair = Keypair.fromSecret(ADMIN_SECRET);
  const server = new rpc.Server(RPC_URL);

  // Generar direcciones para los jugadores
  const godAddress = generatePlayerAddressSync(roomCode, godPlayerId);
  const mortalAddresses = mortalPlayerIds.map(id => generatePlayerAddressSync(roomCode, id));

  console.log('[Relayer] Starting game:', {
    sessionId,
    god: godAddress,
    mortals: mortalAddresses,
  });

  // Crear contrato y operación
  const contract = new Contract(CONTRACT_ID);

  // Crear el vector de mortales
  const mortalsVec = xdr.ScVal.scvVec(
    mortalAddresses.map(addr => new Address(addr).toScVal())
  );

  const operation = contract.call(
    'start_game_relayed',
    nativeToScVal(sessionId, { type: 'u32' }),
    new Address(godAddress).toScVal(),
    mortalsVec
  );

  // Construir transacción
  const account = await server.getAccount(adminKeypair.publicKey());
  const transaction = new TransactionBuilder(account, {
    fee: '100000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();

  // Simular
  const simulated = await server.simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulated)) {
    console.error('[Relayer] Start game simulation error:', simulated.error);
    throw new Error(`Simulation failed: ${simulated.error}`);
  }

  // Preparar y firmar
  const prepared = rpc.assembleTransaction(transaction, simulated).build();
  prepared.sign(adminKeypair);

  // Enviar
  const result = await server.sendTransaction(prepared);
  console.log('[Relayer] Start game transaction sent:', result.hash);

  // Esperar confirmación
  if (result.status === 'PENDING') {
    let txResult = await server.getTransaction(result.hash);
    while (txResult.status === 'NOT_FOUND') {
      await new Promise(resolve => setTimeout(resolve, 1000));
      txResult = await server.getTransaction(result.hash);
    }

    if (txResult.status === 'SUCCESS') {
      console.log('[Relayer] Start game successful');
      return;
    } else {
      console.error('[Relayer] Start game failed:', txResult);
      throw new Error(`Transaction failed: ${txResult.status}`);
    }
  }

  throw new Error(`Unexpected transaction status: ${result.status}`);
}

/**
 * Convierte un room code a session ID numérico
 * Usa un hash simple para generar un número de 32 bits
 */
export function roomCodeToSessionId(roomCode) {
  let hash = 0;
  for (let i = 0; i < roomCode.length; i++) {
    const char = roomCode.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  // Asegurar que sea positivo
  return Math.abs(hash);
}
