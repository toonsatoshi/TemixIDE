// ============================================================
// LendingPool.tact
// ============================================================
// Master orchestrator for TonLend — an Aave-inspired lending
// protocol on The Open Network.

import "@stdlib/deploy";
import "./Messages.tact";
import "./UserAccount.tact";

// ─── Global constants ────────────────────────────────────────
const SECONDS_PER_YEAR: Int = 31_536_000;
const MIN_HEALTH_FACTOR: Int = 1_000_000_000_000_000_000; // 1.0 in 1e18

// ─── Messages ────────────────────────────────────────────────

/// Sent by a Jetton wallet to notify us that a user deposited tokens.
message(0x7362d09c) JettonTransferNotification {
    queryId:    Int as uint64;
    amount:     Int as coins;
    sender:     Address;         // original depositor
    forwardPayload: Slice as remaining;
}

/// User requests to borrow an asset.
message Borrow {
    asset:   Address;   // Jetton master address
    amount:  Int as coins;
}

/// User requests to repay their debt (accompanies a Jetton transfer).
message Repay {
    asset:   Address;
    amount:  Int as coins;
    onBehalfOf: Address;
}

/// Trigger liquidation of an unhealthy position.
message Liquidate {
    borrower:          Address;
    debtAsset:         Address;
    collateralAsset:   Address;
    debtToCover:       Int as coins;
}

/// PriceOracle → LendingPool: push updated price.
message PriceUpdate {
    asset: Address;
    price: Int;   // USD price in 1e8 (e.g. 1 TON = $3.50 → 350_000_000)
}

/// Admin: add a new supported reserve.
message AddReserve {
    asset:             Address;
    jettonWallet:      Address;   // pool's jetton wallet for this asset
    ltv:               Int;       // loan-to-value in bps (e.g. 7500 = 75%)
    liquidationThreshold: Int;    // bps
    liquidationBonus:  Int;       // bps (e.g. 500 = 5% bonus)
    baseRate:          Int;       // annual base borrow rate in RAY
    slope1:            Int;       // rate slope below optimal utilization
    slope2:            Int;       // rate slope above optimal utilization
    optimalUtilization: Int;      // bps (e.g. 8000 = 80%)
}

// ─── Structs ─────────────────────────────────────────────────

struct ReserveData {
    jettonWallet:         Address;
    ltv:                  Int;
    liquidationThreshold: Int;
    liquidationBonus:     Int;
    // Interest rate model params
    baseRate:             Int;
    slope1:               Int;
    slope2:               Int;
    optimalUtilization:   Int;
    // Accounting
    totalLiquidity:       Int;
    totalBorrow:          Int;
    liquidityIndex:       Int;   // RAY-scaled; tracks supply interest accrual
    borrowIndex:          Int;   // RAY-scaled; tracks borrow interest accrual
    lastUpdateTimestamp:  Int;
    // Oracle
    price:                Int;   // latest USD price in 1e8
}

// ─── Contract ────────────────────────────────────────────────

contract LendingPool with Deployable {

    owner:        Address;
    oracle:       Address;                    // PriceOracle contract
    reserves:     map<Address, ReserveData>;  // asset → reserve
    userCodeCell: Cell;                       // compiled UserAccount code

    init(owner: Address, oracle: Address, userCode: Cell) {
        self.owner        = owner;
        self.oracle       = oracle;
        self.reserves     = emptyMap();
        self.userCodeCell = userCode;
    }

    // ── Admin: register a new asset reserve ──────────────────
    receive(msg: AddReserve) {
        require(sender() == self.owner, "Only owner");
        require(self.reserves.get(msg.asset) == null, "Reserve exists");

        self.reserves.set(msg.asset, ReserveData{
            jettonWallet:         msg.jettonWallet,
            ltv:                  msg.ltv,
            liquidationThreshold: msg.liquidationThreshold,
            liquidationBonus:     msg.liquidationBonus,
            baseRate:             msg.baseRate,
            slope1:               msg.slope1,
            slope2:               msg.slope2,
            optimalUtilization:   msg.optimalUtilization,
            totalLiquidity:       0,
            totalBorrow:          0,
            liquidityIndex:       RAY,   // starts at 1.0
            borrowIndex:          RAY,
            lastUpdateTimestamp:  now(),
            price:                0
        });
    }

    // ── Oracle: receive price update ─────────────────────────
    receive(msg: PriceUpdate) {
        require(sender() == self.oracle, "Only oracle");
        let reserve: ReserveData? = self.reserves.get(msg.asset);
        require(reserve != null, "Unknown asset");
        let r: ReserveData = reserve!!;
        r.price = msg.price;
        self.reserves.set(msg.asset, r);
    }

    // ── Deposit: Jetton wallet forwards transfer notification ─
    //    The pool's jetton wallet calls this after receiving tokens.
    receive(msg: JettonTransferNotification) {
        // Identify which asset this jetton wallet belongs to
        let asset: Address = self._findAssetByWallet(sender());
        require(asset != newAddress(0, 0), "Unknown jetton wallet");

        // Accrue interest before any state change
        let r: ReserveData = self._accrueInterest(asset);

        // Update reserve liquidity
        r.totalLiquidity = r.totalLiquidity + msg.amount;
        self.reserves.set(asset, r);

        // Deploy (or message) the user's UserAccount, confirm deposit
        let userAcct: Address = self._userAccountAddress(msg.sender);
        send(SendParameters{
            to:    userAcct,
            value: ton("0.05"),
            mode:  SendIgnoreErrors,
            bounce: true,
            body:  DepositConfirm{
                asset:      asset,
                amount:     msg.amount,
                rateIndex:  r.liquidityIndex
            }.toCell(),
            code:  self.userCodeCell,
            data:  self._userAccountInitData(msg.sender)
        });
    }

    // ── Borrow ────────────────────────────────────────────────
    receive(msg: Borrow) {
        let reserve: ReserveData? = self.reserves.get(msg.asset);
        require(reserve != null, "Unknown asset");
        let r: ReserveData = reserve!!;
        require(msg.amount <= r.totalLiquidity - r.totalBorrow, "Insufficient liquidity");

        // Forward request to the user's UserAccount for collateral check
        let userAcct: Address = self._userAccountAddress(sender());
        send(SendParameters{
            to:    userAcct,
            value: ton("0.1"),
            mode:  SendIgnoreErrors,
            bounce: true,
            body:  ExecuteBorrow{
                asset:    msg.asset,
                amount:   msg.amount,
                borrower: sender(),
                // UserAccount will fill these; we pass 0 as placeholders
                totalCollateralUSD: 0,
                totalDebtUSD:       0
            }.toCell()
        });
    }

    // ── ExecuteBorrow callback from UserAccount ───────────────
    //    After UserAccount verifies health factor, it sends this back.
    receive(msg: ExecuteBorrow) {
        // Verify sender IS the legitimate UserAccount for msg.borrower
        require(sender() == self._userAccountAddress(msg.borrower), "Unauthorized");

        let reserve: ReserveData? = self.reserves.get(msg.asset);
        require(reserve != null, "Unknown asset");
        let r: ReserveData = self._accrueInterest(msg.asset);

        // Verify health factor (collateral covers debt + new borrow)
        let newDebtUSD: Int = msg.totalDebtUSD + (msg.amount * r.price / 100_000_000);
        let maxDebt: Int    = msg.totalCollateralUSD * r.ltv / 10_000;
        require(newDebtUSD <= maxDebt, "Insufficient collateral");

        // Update reserve
        r.totalBorrow    = r.totalBorrow + msg.amount;
        r.totalLiquidity = r.totalLiquidity - msg.amount;
        self.reserves.set(msg.asset, r);

        // Send tokens to borrower via the pool's jetton wallet
        // (In production: call JettonTransfer on self.jettonWallet)
        // Simplified: send TON-equivalent for illustration
        send(SendParameters{
            to:    msg.borrower,
            value: msg.amount,  // placeholder — real impl uses jetton transfer
            mode:  SendIgnoreErrors,
            bounce: false,
            body:  "borrow_ok".asComment()
        });

        // Confirm borrow to UserAccount so it updates its debt state
        send(SendParameters{
            to:    sender(),
            value: ton("0.02"),
            mode:  SendIgnoreErrors,
            bounce: false,
            body:  BorrowConfirmed{
                asset:       msg.asset,
                amount:      msg.amount,
                borrowIndex: r.borrowIndex
            }.toCell()
        });
    }

    // ── Liquidation ───────────────────────────────────────────
    receive(msg: Liquidate) {
        let debtReserve: ReserveData? = self.reserves.get(msg.debtAsset);
        let collReserve: ReserveData? = self.reserves.get(msg.collateralAsset);
        require(debtReserve != null && collReserve != null, "Unknown asset");

        let dr: ReserveData = debtReserve!!;
        let cr: ReserveData = collReserve!!;

        // Forward to borrower's UserAccount to do health factor check & accounting
        let userAcct: Address = self._userAccountAddress(msg.borrower);
        send(SendParameters{
            to:    userAcct,
            value: ton("0.15"),
            mode:  SendIgnoreErrors,
            bounce: true,
            body:  ExecuteLiquidation{
                liquidator:      sender(),
                debtAsset:       msg.debtAsset,
                collateralAsset: msg.collateralAsset,
                debtToCover:     msg.debtToCover,
                collateralPrice: cr.price,
                debtPrice:       dr.price,
                liquidationBonus: cr.liquidationBonus
            }.toCell()
        });
    }

    // ── Internal: accrue interest for a reserve ───────────────
    fun _accrueInterest(asset: Address): ReserveData {
        let reserve: ReserveData? = self.reserves.get(asset);
        require(reserve != null, "Unknown asset");
        let r: ReserveData = reserve!!;

        let elapsed: Int = now() - r.lastUpdateTimestamp;
        if (elapsed == 0) { return r; }

        // Utilization rate = totalBorrow / totalLiquidity  (in RAY)
        let utilization: Int = 0;
        if (r.totalLiquidity > 0) {
            utilization = r.totalBorrow * RAY / r.totalLiquidity;
        }

        // Kinked borrow rate
        let optUtil: Int   = r.optimalUtilization * RAY / 10_000;
        let borrowRate: Int = 0;
        if (utilization <= optUtil) {
            borrowRate = r.baseRate + r.slope1 * utilization / RAY;
        } else {
            let excessUtil: Int = utilization - optUtil;
            borrowRate = r.baseRate + r.slope1 + r.slope2 * excessUtil / (RAY - optUtil);
        }

        // Compound interest (simplified linear approximation for gas efficiency)
        let interestFactor: Int = borrowRate * elapsed / SECONDS_PER_YEAR;

        // Update borrow index
        r.borrowIndex    = r.borrowIndex + r.borrowIndex * interestFactor / RAY;

        // Supply rate = borrow rate * utilization (interest flows to depositors)
        let supplyRate: Int   = borrowRate * utilization / RAY;
        let supplyFactor: Int = supplyRate * elapsed / SECONDS_PER_YEAR;
        r.liquidityIndex      = r.liquidityIndex + r.liquidityIndex * supplyFactor / RAY;

        r.lastUpdateTimestamp = now();
        self.reserves.set(asset, r);
        return r;
    }

    // ── Internal: find asset address by its jetton wallet ─────
    fun _findAssetByWallet(wallet: Address): Address {
        foreach (asset, r in self.reserves) {
            if (r.jettonWallet == wallet) {
                return asset;
            }
        }
        return newAddress(0, 0);
    }

    // ── Internal: compute deterministic UserAccount address ───
    fun _userAccountAddress(user: Address): Address {
        return contractAddress(initOf UserAccount(myAddress(), user));
    }

    // ── Internal: UserAccount init data cell ─────────────────
    fun _userAccountInitData(user: Address): Cell {
        return initOf UserAccount(myAddress(), user).data;
    }

    // ── Getters ───────────────────────────────────────────────

    get fun reserveData(asset: Address): ReserveData? {
        return self.reserves.get(asset);
    }

    get fun utilizationRate(asset: Address): Int {
        let r: ReserveData? = self.reserves.get(asset);
        if (r == null) { return 0; }
        let res: ReserveData = r!!;
        if (res.totalLiquidity == 0) { return 0; }
        return res.totalBorrow * 10_000 / res.totalLiquidity;
    }

    get fun userAccountAddress(user: Address): Address {
        return self._userAccountAddress(user);
    }

    get fun currentBorrowRate(asset: Address): Int {
        let r: ReserveData? = self.reserves.get(asset);
        if (r == null) { return 0; }
        let res: ReserveData = r!!;
        let utilization: Int = 0;
        if (res.totalLiquidity > 0) {
            utilization = res.totalBorrow * RAY / res.totalLiquidity;
        }
        let optUtil: Int = res.optimalUtilization * RAY / 10_000;
        if (utilization <= optUtil) {
            return res.baseRate + res.slope1 * utilization / RAY;
        }
        let excessUtil: Int = utilization - optUtil;
        return res.baseRate + res.slope1 + res.slope2 * excessUtil / (RAY - optUtil);
    }
}
