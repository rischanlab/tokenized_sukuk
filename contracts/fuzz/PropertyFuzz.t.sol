// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EvidenceRegistry} from "../registry/EvidenceRegistry.sol";
import {IdentityRegistry} from "../registry/IdentityRegistry.sol";
import {SukukPolicyEngine} from "../policy/SukukPolicyEngine.sol";
import {BasicCompliance} from "../baseline/BasicCompliance.sol";
import {SukukToken} from "../token/SukukToken.sol";
import {IIdentityRegistry} from "../interfaces/IIdentityRegistry.sol";
import {ISukukCompliance} from "../interfaces/ISukukCompliance.sol";

/// Minimal interface to the test runner's cheatcodes (Foundry-compatible).
interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8, bytes32, bytes32);
    function addr(uint256 privateKey) external pure returns (address);
}

abstract contract FuzzBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant START = 1_700_000_000;
    bytes32 internal constant INSTRUMENT = keccak256("FUZZ-SUKUK");

    uint256 internal constant PK_WAKEEL = 0xA1;
    uint256 internal constant PK_TRUSTEE = 0xA2;
    uint256 internal constant PK_LEGAL = 0xA3;
    uint256 internal constant PK_VALUER = 0xA4;
    uint256 internal constant PK_SHARIAH = 0xA5;

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}

/// Property: under policy B2 an issuance is authorised exactly when every
/// allocated asset is backing-eligible and within its attested value, the
/// allocation fits the proceeds, and non-debt allocations reach 3,300 basis
/// points of the proceeds (I1, I5).
contract IssuanceRuleFuzzTest is FuzzBase {
    EvidenceRegistry internal registry;
    SukukPolicyEngine internal engine;
    SukukToken internal token;
    IdentityRegistry internal identity;
    address internal investor = address(0xBEEF);
    bytes32 internal constant ASSET_N = keccak256("FUZZ-ASSET-N");
    bytes32 internal constant ASSET_D = keccak256("FUZZ-ASSET-D");
    uint64 internal seq = 1;

    function setUp() public {
        vm.warp(START);
        identity = new IdentityRegistry(address(this));
        registry = new EvidenceRegistry(INSTRUMENT, 30 days, address(this));
        address[] memory governors = new address[](3);
        governors[0] = address(this);
        governors[1] = address(0xB2);
        governors[2] = address(0xB3);
        engine = new SukukPolicyEngine(
            registry,
            governors,
            2,
            1 days,
            SukukPolicyEngine.PolicyParams(1, 3300, true, true, true, keccak256("policy"))
        );
        token = new SukukToken(
            "Fuzz Sukuk",
            "FZS",
            IIdentityRegistry(address(identity)),
            ISukukCompliance(address(engine)),
            uint64(START + 365 days),
            address(this)
        );
        engine.bindToken(address(token));
        identity.registerIdentity(investor, 458, uint64(START + 3650 days));
        registry.registerAttestor(vm.addr(PK_WAKEEL), registry.WAKEEL());
        registry.registerAttestor(vm.addr(PK_TRUSTEE), registry.TRUSTEE());
        registry.registerAttestor(vm.addr(PK_LEGAL), registry.LEGAL_VERIFIER());
        registry.registerAttestor(vm.addr(PK_VALUER), registry.VALUER());
        registry.registerAttestor(vm.addr(PK_SHARIAH), registry.SHARIAH_ADVISER());
        _claim(PK_SHARIAH, 5, INSTRUMENT, 1, 0, 1); // endorsed for version 1
    }

    function _claim(uint256 pk, uint8 claimType, bytes32 subject, uint8 code, uint256 amount, uint32 version) internal {
        EvidenceRegistry.Attestation memory a = EvidenceRegistry.Attestation({
            instrumentId: INSTRUMENT,
            claimType: claimType,
            subjectId: subject,
            code: code,
            flag: false,
            amount: amount,
            policyVersion: version,
            evidenceHash: keccak256(abi.encode(subject, claimType)),
            seq: seq++,
            issuedAt: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 7 days)
        });
        registry.submitAttestation(a, vm.addr(pk), _sig(pk, registry.hashAttestation(a)));
    }

    function _publish(bytes32 asset, uint256 value, bool nonDebt) internal {
        _claim(PK_LEGAL, 1, asset, 1, 0, 0);
        _claim(PK_VALUER, 2, asset, 0, value, 0);
        _claim(PK_SHARIAH, 3, asset, nonDebt ? 1 : 2, 0, 1);
    }

    function testFuzz_IssuanceMinimum(
        uint96 proceedsRaw,
        uint96 xNRaw,
        uint96 xDRaw,
        uint96 valueN,
        uint96 valueD,
        bool classN
    ) public {
        uint256 proceeds = uint256(proceedsRaw) + 1;
        uint256 xN = uint256(xNRaw) % (proceeds + 1);
        uint256 xD = uint256(xDRaw) % (proceeds - xN + 1);
        _publish(ASSET_N, valueN, classN);
        _publish(ASSET_D, valueD, false);

        bool withinValue = (xN == 0 || (valueN > 0 && xN <= valueN)) &&
            (xD == 0 || (valueD > 0 && xD <= valueD));
        uint256 nonDebt = classN ? xN : 0;
        bool expected = withinValue && nonDebt * 10_000 >= 3_300 * proceeds;
        (bytes memory evidence, bytes32 trancheId) = _evidence(proceeds, xN, xD);
        _issueAndCheck(evidence, trancheId, proceeds, nonDebt, expected);
    }

    function _evidence(uint256 proceeds, uint256 xN, uint256 xD)
        internal
        view
        returns (bytes memory evidence, bytes32 trancheId)
    {
        uint256 count = (xN > 0 ? 1 : 0) + (xD > 0 ? 1 : 0);
        bytes32[] memory ids = new bytes32[](count);
        uint256[] memory amounts = new uint256[](count);
        // Asset identifiers must be strictly increasing.
        bool nFirst = uint256(ASSET_N) < uint256(ASSET_D);
        uint256 k = 0;
        for (uint256 pass = 0; pass < 2; ++pass) {
            bool takeN = (pass == 0) == nFirst;
            uint256 m = takeN ? xN : xD;
            if (m > 0) {
                ids[k] = takeN ? ASSET_N : ASSET_D;
                amounts[k] = m;
                ++k;
            }
        }
        trancheId = keccak256(abi.encode(proceeds, xN, xD));
        EvidenceRegistry.TrancheAllocation memory t = EvidenceRegistry.TrancheAllocation({
            instrumentId: INSTRUMENT,
            trancheId: trancheId,
            proceeds: proceeds,
            assetIds: ids,
            amounts: amounts,
            policyVersion: 1,
            evidenceHash: keccak256("allocation memo"),
            issuedAt: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 1 days)
        });
        bytes32 digest = registry.hashTranche(t);
        address[] memory signers = new address[](2);
        signers[0] = vm.addr(PK_WAKEEL);
        signers[1] = vm.addr(PK_TRUSTEE);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sig(PK_WAKEEL, digest);
        sigs[1] = _sig(PK_TRUSTEE, digest);
        evidence = abi.encode(t, signers, sigs);
    }

    function _issueAndCheck(
        bytes memory evidence,
        bytes32 trancheId,
        uint256 proceeds,
        uint256 nonDebt,
        bool expected
    ) internal {
        address[] memory recipients = new address[](1);
        recipients[0] = investor;
        uint256[] memory units = new uint256[](1);
        units[0] = proceeds;
        try token.issue(evidence, recipients, units) {
            require(expected, "authorised an issuance the rule denies");
            (, uint256 recordedNonDebt, , , ) = engine.tranches(trancheId);
            require(recordedNonDebt == nonDebt, "recorded non-debt amount");
            require(recordedNonDebt * 10_000 >= 3_300 * proceeds, "I1");
            require(token.totalSupply() == proceeds, "supply");
        } catch {
            require(!expected, "denied an issuance the rule allows");
            require(token.totalSupply() == 0, "no units on denial");
        }
    }
}

/// Property: for any sequence of redemption requests and settlement
/// confirmations, issued units equal supply plus pending plus settled units,
/// and no claim is settled beyond its amount (I6).
contract RedemptionAccountingFuzzTest is FuzzBase {
    SukukToken internal token;
    address internal constant H1 = address(0x1111);
    address internal constant H2 = address(0x2222);
    uint256[] internal requested;
    uint256[] internal settledOf;

    function setUp() public {
        vm.warp(START);
        IdentityRegistry identity = new IdentityRegistry(address(this));
        BasicCompliance compliance = new BasicCompliance();
        token = new SukukToken(
            "Fuzz Sukuk",
            "FZS",
            IIdentityRegistry(address(identity)),
            ISukukCompliance(address(compliance)),
            uint64(START + 365 days),
            address(this)
        );
        compliance.bindToken(address(token));
        token.grantRole(token.SETTLEMENT_ROLE(), address(this));
        identity.registerIdentity(H1, 458, uint64(START + 3650 days));
        identity.registerIdentity(H2, 458, uint64(START + 3650 days));
    }

    function testFuzz_RedemptionAccounting(uint96 a1, uint96 a2, uint256[8] calldata ops) public {
        address[] memory holders = new address[](2);
        holders[0] = H1;
        holders[1] = H2;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = uint256(a1) + 1;
        amounts[1] = uint256(a2) + 1;
        token.issue("", holders, amounts);
        vm.warp(START + 365 days);

        uint256 pending = 0;
        uint256 settled = 0;
        for (uint256 i = 0; i < ops.length; ++i) {
            uint256 op = ops[i];
            if (op % 2 == 0) {
                address h = holders[(op >> 1) % 2];
                uint256 bal = token.balanceOf(h);
                uint256 amount = (op >> 8) % (bal + bal / 4 + 2);
                vm.prank(h);
                try token.requestRedemption(amount) returns (uint256 rid) {
                    require(amount > 0 && amount <= bal, "accepted invalid request");
                    require(rid == requested.length + 1, "redemption id");
                    requested.push(amount);
                    settledOf.push(0);
                    pending += amount;
                } catch {
                    require(amount == 0 || amount > bal, "rejected valid request");
                }
            } else {
                uint256 n = requested.length;
                uint256 rid = ((op >> 1) % (n + 1)) + 1; // may name a missing claim
                uint256 remaining = rid <= n ? requested[rid - 1] - settledOf[rid - 1] : 0;
                uint256 amount = (op >> 8) % (remaining + remaining / 4 + 2);
                bool valid = rid <= n && amount > 0 && amount <= remaining;
                try token.confirmSettlement(rid, amount, keccak256(abi.encode(i))) {
                    require(valid, "accepted invalid settlement");
                    settledOf[rid - 1] += amount;
                    pending -= amount;
                    settled += amount;
                } catch {
                    require(!valid, "rejected valid settlement");
                }
            }
            require(token.pendingRedemptionUnits() == pending, "pending");
            require(token.settledRedemptionUnits() == settled, "settled");
            require(
                token.totalSupply() + pending + settled == token.totalIssued(),
                "I6: issued = supply + pending + settled"
            );
        }
    }
}

/// Properties of claim submission and currency: a claim is accepted exactly
/// when its window contains the current time and is at most 30 days long,
/// it counts as current exactly until its expiry second, and sequence numbers
/// only increase (I4).
contract ClaimWindowFuzzTest is FuzzBase {
    EvidenceRegistry internal registry;
    bytes32 internal constant ASSET = keccak256("FUZZ-ASSET");

    function setUp() public {
        vm.warp(START);
        registry = new EvidenceRegistry(INSTRUMENT, 30 days, address(this));
        registry.registerAttestor(vm.addr(PK_VALUER), registry.VALUER());
    }

    function _valuation(uint64 seq, uint64 issuedAt, uint64 validUntil)
        internal
        view
        returns (EvidenceRegistry.Attestation memory a, bytes memory sig)
    {
        a = EvidenceRegistry.Attestation({
            instrumentId: INSTRUMENT,
            claimType: 2,
            subjectId: ASSET,
            code: 0,
            flag: false,
            amount: 1e24,
            policyVersion: 0,
            evidenceHash: keccak256("valuation report"),
            seq: seq,
            issuedAt: issuedAt,
            validUntil: validUntil
        });
        sig = _sig(PK_VALUER, registry.hashAttestation(a));
    }

    function testFuzz_ValidityWindow(uint32 issuedOffset, uint32 length, uint32 later) public {
        uint64 issuedAt = uint64(START - 30 days + (uint256(issuedOffset) % 60 days));
        uint64 validUntil = issuedAt + uint64(uint256(length) % 60 days);
        (EvidenceRegistry.Attestation memory a, bytes memory sig) = _valuation(1, issuedAt, validUntil);
        bool expected = issuedAt <= START && START <= validUntil && validUntil - issuedAt <= 30 days;
        try registry.submitAttestation(a, vm.addr(PK_VALUER), sig) {
            require(expected, "accepted a claim outside its window");
            uint256 t = START + (uint256(later) % 60 days);
            vm.warp(t);
            require(registry.isCurrent(ASSET, 2) == (t <= validUntil), "currency at use");
        } catch {
            require(!expected, "rejected a claim inside its window");
        }
    }

    function testFuzz_SequenceMonotonic(uint64 first, uint64 second) public {
        if (first == 0) first = 1;
        (EvidenceRegistry.Attestation memory a, bytes memory sig) = _valuation(first, uint64(START), uint64(START + 1 days));
        registry.submitAttestation(a, vm.addr(PK_VALUER), sig);
        (EvidenceRegistry.Attestation memory b, bytes memory sig2) = _valuation(second, uint64(START), uint64(START + 1 days));
        try registry.submitAttestation(b, vm.addr(PK_VALUER), sig2) {
            require(second > first, "accepted an older or replayed sequence number");
        } catch {
            require(second <= first, "rejected a newer sequence number");
        }
        require(registry.lastSeq(ASSET, 2) == (second > first ? second : first), "last sequence");
    }
}
