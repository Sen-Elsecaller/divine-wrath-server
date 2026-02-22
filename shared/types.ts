// Shared types for Divine Wrath

export type ClaimTypeId = 'row' | 'column' | 'adjacent';

export interface ClaimTypeConfig {
  id: ClaimTypeId;
  label: string;
  needsValue: boolean;
  values: number[];
  formatClaim: (target: string, value?: number | boolean) => string;
}

export type Phase = 'lobby' | 'setup' | 'claiming' | 'deduction' | 'round_transition' | 'ended';

export type Role = 'god' | 'mortal';

export type EyebrowStyle = 'neutral' | 'angry' | 'happy' | 'worried';

export interface AvatarConfig {
  color: string;
  eyebrows: EyebrowStyle;
}

export interface Player {
  id: string;
  name: string;
  role: Role | null;
  position: number | null;
  isHost: boolean;
  isReady: boolean;
  avatar?: AvatarConfig;
}

export interface Claim {
  id: string;  // Unique claim ID for verification
  playerId: string;
  playerName: string;
  targetPlayerId: string;
  targetPlayerName: string;
  claimType: ClaimTypeId;
  claimValue: number | boolean;
  verified: boolean;       // Has God verified this claim?
  isTrue: boolean | null;  // null until verified
  turn: number;
}

export interface Attack {
  cell: number;
  turn: number;
  round: number;
  hit: boolean;
  victimName: string | null;
}

// Score tracking
export type ScoreAction = 'survive_turn' | 'true_self_claim' | 'god_find' | 'god_penalty_miss' | 'god_penalty_hit';

export interface ScoreEntry {
  round: number;
  turn: number;
  action: ScoreAction;
  points: number;
}

export interface PlayerScore {
  playerId: string;
  playerName: string;
  total: number;
  breakdown: ScoreEntry[];
}

// God tracking for transitions
export interface GodHistory {
  playerId: string;
  consecutiveRounds: number;
  hasPenalty: boolean;
  missedAttacks: number;
}

// Round result for transitions
export interface RoundResult {
  winner: 'god' | 'mortals';
  needsGodChoice: boolean;
  canStay?: boolean;
  godPlayerId?: string;
}

export interface Room {
  code: string;
  players: Player[];
  phase: Phase;
  turn: number;
  currentRound: number;
  totalRounds: number;
  currentPlayerIndex: number;
  claims: Claim[];
  attacks: Attack[];
  verificationsRemaining: number;  // God's ZK proof verifications available
  scores: Record<string, PlayerScore>;
  godHistory: GodHistory | null;
  roundWinner: 'god' | 'mortals' | null;
}

// Helper to check if a claim already exists
export function claimExists(
  claims: Claim[],
  targetPlayerId: string,
  claimType: ClaimTypeId,
  claimValue: number | boolean
): boolean {
  return claims.some(
    c =>
      c.targetPlayerId === targetPlayerId &&
      c.claimType === claimType &&
      c.claimValue === claimValue
  );
}
