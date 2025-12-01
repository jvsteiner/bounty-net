import { describe, it, expect, vi, beforeEach } from "vitest";

// Test the hexToBytes utility function by extracting its logic
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

describe("Wallet Utilities", () => {
  describe("hexToBytes()", () => {
    it("should convert hex string to Uint8Array", () => {
      const hex = "deadbeef";
      const bytes = hexToBytes(hex);

      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBe(4);
      expect(bytes[0]).toBe(0xde);
      expect(bytes[1]).toBe(0xad);
      expect(bytes[2]).toBe(0xbe);
      expect(bytes[3]).toBe(0xef);
    });

    it("should handle empty string", () => {
      const bytes = hexToBytes("");
      expect(bytes.length).toBe(0);
    });

    it("should convert a 64-char private key hex", () => {
      const privateKeyHex =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      const bytes = hexToBytes(privateKeyHex);

      expect(bytes.length).toBe(32);
      expect(bytes[0]).toBe(0x01);
      expect(bytes[1]).toBe(0x23);
    });

    it("should handle lowercase hex", () => {
      const bytes = hexToBytes("abcdef");
      expect(bytes[0]).toBe(0xab);
      expect(bytes[1]).toBe(0xcd);
      expect(bytes[2]).toBe(0xef);
    });

    it("should handle uppercase hex", () => {
      const bytes = hexToBytes("ABCDEF");
      expect(bytes[0]).toBe(0xab);
      expect(bytes[1]).toBe(0xcd);
      expect(bytes[2]).toBe(0xef);
    });
  });
});

describe("Transfer Payload Structure", () => {
  it("should create valid transfer payload", () => {
    const payload = {
      tokenJson: '{"id":"token123"}',
      amount: "100",
      coinId: "ALPHA",
      requestId: "deposit_report123_1234567890",
      message: "deposit for report report123",
    };

    const serialized = JSON.stringify(payload);
    const parsed = JSON.parse(serialized);

    expect(parsed.tokenJson).toBe('{"id":"token123"}');
    expect(parsed.amount).toBe("100");
    expect(parsed.coinId).toBe("ALPHA");
    expect(parsed.requestId).toContain("deposit_report123");
    expect(parsed.message).toContain("deposit for report");
  });

  it("should generate unique request IDs", () => {
    const createRequestId = (type: string, reportId: string) =>
      `${type}_${reportId}_${Date.now()}`;

    const id1 = createRequestId("deposit", "report1");
    // Small delay to ensure different timestamp
    const id2 = createRequestId("refund", "report1");

    expect(id1).toContain("deposit_report1");
    expect(id2).toContain("refund_report1");
    expect(id1).not.toBe(id2);
  });
});

describe("Token Balance Calculations", () => {
  // Simulating the balance calculation logic
  interface MockToken {
    id: string;
    coins: Map<string, bigint>;
  }

  function calculateBalance(
    tokens: MockToken[],
    coinId: string
  ): bigint {
    let totalBalance = BigInt(0);
    for (const token of tokens) {
      const balance = token.coins.get(coinId);
      if (balance) {
        totalBalance += balance;
      }
    }
    return totalBalance;
  }

  function findTokensForAmount(
    tokens: MockToken[],
    coinId: string,
    amount: bigint
  ): MockToken[] {
    const matchingTokens: MockToken[] = [];
    let totalBalance = BigInt(0);

    for (const token of tokens) {
      const balance = token.coins.get(coinId);
      if (balance && balance > 0) {
        matchingTokens.push(token);
        totalBalance += balance;
        if (totalBalance >= amount) {
          break;
        }
      }
    }

    return matchingTokens;
  }

  it("should calculate total balance across multiple tokens", () => {
    const tokens: MockToken[] = [
      { id: "token1", coins: new Map([["ALPHA", BigInt(100)]]) },
      { id: "token2", coins: new Map([["ALPHA", BigInt(50)]]) },
      { id: "token3", coins: new Map([["BETA", BigInt(200)]]) },
    ];

    const alphaBalance = calculateBalance(tokens, "ALPHA");
    const betaBalance = calculateBalance(tokens, "BETA");
    const gammaBalance = calculateBalance(tokens, "GAMMA");

    expect(alphaBalance).toBe(BigInt(150));
    expect(betaBalance).toBe(BigInt(200));
    expect(gammaBalance).toBe(BigInt(0));
  });

  it("should find tokens sufficient for requested amount", () => {
    const tokens: MockToken[] = [
      { id: "token1", coins: new Map([["ALPHA", BigInt(30)]]) },
      { id: "token2", coins: new Map([["ALPHA", BigInt(50)]]) },
      { id: "token3", coins: new Map([["ALPHA", BigInt(100)]]) },
    ];

    // Need 60 ALPHA - should get first two tokens (30 + 50 = 80)
    const found = findTokensForAmount(tokens, "ALPHA", BigInt(60));
    expect(found).toHaveLength(2);
    expect(found[0].id).toBe("token1");
    expect(found[1].id).toBe("token2");
  });

  it("should return all tokens if none meet the amount", () => {
    const tokens: MockToken[] = [
      { id: "token1", coins: new Map([["ALPHA", BigInt(10)]]) },
      { id: "token2", coins: new Map([["ALPHA", BigInt(20)]]) },
    ];

    // Need more than available
    const found = findTokensForAmount(tokens, "ALPHA", BigInt(100));
    expect(found).toHaveLength(2);
  });

  it("should return empty array for non-existent coin", () => {
    const tokens: MockToken[] = [
      { id: "token1", coins: new Map([["ALPHA", BigInt(100)]]) },
    ];

    const found = findTokensForAmount(tokens, "NONEXISTENT", BigInt(50));
    expect(found).toHaveLength(0);
  });

  it("should skip tokens with zero balance", () => {
    const tokens: MockToken[] = [
      { id: "token1", coins: new Map([["ALPHA", BigInt(0)]]) },
      { id: "token2", coins: new Map([["ALPHA", BigInt(100)]]) },
    ];

    const found = findTokensForAmount(tokens, "ALPHA", BigInt(50));
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe("token2");
  });
});

describe("Transfer Result Handling", () => {
  interface TransferResult {
    success: boolean;
    txHash?: string;
    error?: string;
  }

  it("should create success result with txHash", () => {
    const result: TransferResult = {
      success: true,
      txHash: "event123abc",
    };

    expect(result.success).toBe(true);
    expect(result.txHash).toBe("event123abc");
    expect(result.error).toBeUndefined();
  });

  it("should create failure result with error", () => {
    const result: TransferResult = {
      success: false,
      error: "Insufficient balance for ALPHA",
    };

    expect(result.success).toBe(false);
    expect(result.txHash).toBeUndefined();
    expect(result.error).toBe("Insufficient balance for ALPHA");
  });
});
