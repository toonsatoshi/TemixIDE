// ============================================================
// Messages.tact
// ============================================================

const RAY: Int = 1_000_000_000_000_000_000_000_000_000;
const ONE_E18: Int = 1_000_000_000_000_000_000;

message DepositConfirm {
    asset:     Address;
    amount:    Int as coins;
    rateIndex: Int;
}

message ExecuteBorrow {
    asset:              Address;
    amount:             Int as coins;
    borrower:           Address;
    totalCollateralUSD: Int;
    totalDebtUSD:       Int;
}

message ExecuteLiquidation {
    liquidator:       Address;
    debtAsset:        Address;
    collateralAsset:  Address;
    debtToCover:      Int as coins;
    collateralPrice:  Int;
    debtPrice:        Int;
    liquidationBonus: Int;
}

message BorrowConfirmed {
    asset:       Address;
    amount:      Int as coins;
    borrowIndex: Int;
}

struct SupplyPosition {
    scaledBalance: Int;
    lastIndex:     Int;
}

struct BorrowPosition {
    scaledDebt: Int;
    lastIndex:  Int;
}
