#!/usr/bin/env node

/**
 * Test del relayer - Envía un proof de prueba al contrato.
 *
 * Uso: node test-relayer.js
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import * as snarkjs from 'snarkjs';
import { submitClaimRelayed, isRelayerConfigured, getRelayerAddress } from './relayer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Paths a los artifacts del circuito
const circomDir = join(__dirname, '../../divine-wrath-circom');
const wasmPath = join(circomDir, 'build/divine_wrath_js/divine_wrath.wasm');
const zkeyPath = join(circomDir, 'build/divine_wrath_final.zkey');
const vkPath = join(circomDir, 'build/verification_key.json');

async function main() {
  console.log('=== Divine Wrath Relayer Test ===\n');

  // Verificar configuración
  if (!isRelayerConfigured()) {
    console.error('ERROR: Relayer no configurado. Asegúrate de tener DIVINE_WRATH_ADMIN_SECRET en .env');
    process.exit(1);
  }

  console.log(`Relayer address: ${getRelayerAddress()}`);
  console.log(`Contract ID: ${process.env.DIVINE_WRATH_CONTRACT_ID || 'CC3D5AH5B3DOGZPJIX2T52PIT3Q2Y6XT3XIAG2FYCK32SBVENIXJFYQZ'}`);

  // Input de prueba: posición 5, claim "estoy en fila 1", resultado true
  // Grid 3x3:
  //   pos 1,2,3 → row 0
  //   pos 4,5,6 → row 1
  //   pos 7,8,9 → row 2
  // Posición 5 → row = 1 (correcto)
  const testInput = {
    position: 5,        // SECRETO
    claimType: 0,       // 0 = row
    claimValue: 1,      // fila 1 (0-indexed)
    expectedResult: 1   // true
  };

  console.log('\n--- Generando ZK Proof ---');
  console.log(`Input secreto: position = ${testInput.position}`);
  console.log(`Input público: claimType = ${testInput.claimType} (row)`);
  console.log(`Input público: claimValue = ${testInput.claimValue}`);
  console.log(`Input público: expectedResult = ${testInput.expectedResult}`);

  // Generar proof
  const startTime = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    testInput,
    wasmPath,
    zkeyPath
  );
  const proofTime = Date.now() - startTime;

  console.log(`\nProof generado en ${proofTime}ms`);
  console.log(`Public signals: ${JSON.stringify(publicSignals)}`);

  // Verificar localmente
  const vk = JSON.parse(readFileSync(vkPath, 'utf8'));
  const localValid = await snarkjs.groth16.verify(vk, publicSignals, proof);
  console.log(`Verificación local: ${localValid ? 'VÁLIDO ✓' : 'INVÁLIDO ✗'}`);

  if (!localValid) {
    console.error('ERROR: Proof inválido localmente. Algo está mal.');
    process.exit(1);
  }

  // Enviar al contrato
  console.log('\n--- Enviando al Contrato ---');

  // Usar un session_id de prueba (hash de un room code ficticio)
  const testSessionId = 12345678;
  // Usar la dirección del relayer como "mortal" para la prueba
  const mortalAddress = getRelayerAddress();

  console.log(`Session ID: ${testSessionId}`);
  console.log(`Mortal address: ${mortalAddress}`);
  console.log(`Claim: type=${testInput.claimType}, value=${testInput.claimValue}, expected=${testInput.expectedResult}`);

  try {
    const startSubmit = Date.now();
    const result = await submitClaimRelayed(
      testSessionId,
      mortalAddress,
      testInput.claimType,
      testInput.claimValue,
      testInput.expectedResult === 1,
      proof
    );
    const submitTime = Date.now() - startSubmit;

    console.log(`\n✓ Claim enviado exitosamente en ${submitTime}ms`);
    console.log(`Resultado: ${result}`);

  } catch (error) {
    console.error(`\n✗ Error al enviar claim:`);
    console.error(error.message);

    // Si el error es "GameNotFound", es esperado (no hay partida activa)
    if (error.message.includes('GameNotFound') || error.message.includes('Simulation failed')) {
      console.log('\nNOTA: Este error es esperado si no hay una partida activa.');
      console.log('El proof fue generado correctamente y el relayer funciona.');
      console.log('Para un test completo, primero inicia una partida con start_game().');
    }
  }

  console.log('\n=== Test completado ===');
}

main().catch(console.error);
