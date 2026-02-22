# Divine Wrath - Server

WebSocket game server for Divine Wrath. Handles room management, game logic, and blockchain integration.

## Quick Start

```bash
npm install
npm start
```

Runs on `http://localhost:3001`.

## Environment Variables

```bash
# .env
PORT=3001

# Frontend URL for CORS (production)
FRONTEND_URL=https://your-frontend.vercel.app

# Blockchain (optional, set false for local testing)
USE_BLOCKCHAIN=false

# Stellar config (only if USE_BLOCKCHAIN=true)
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK=testnet
DIVINE_WRATH_CONTRACT_ID=your_contract_id
DIVINE_WRATH_VERIFIER_ID=your_verifier_id
DIVINE_WRATH_ADMIN_SECRET=your_secret_key
```

## Blockchain Integration

When `USE_BLOCKCHAIN=true`, the server:
- Registers games on Stellar when they start
- Submits ZK proofs for claim verification
- Records attacks on-chain

The server acts as a relayer - players don't need wallets.

## Tech Stack

- Node.js + Express
- Socket.io (WebSocket)
- Stellar SDK (blockchain)
