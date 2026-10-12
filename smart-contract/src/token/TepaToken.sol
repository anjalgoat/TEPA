// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Restricted, whole-unit prototype with an ERC-3643-style eligibility preflight.
/// Identity decisions remain off-chain; this registry stores only pseudonymous commitments.
contract TepaToken {
    error Unauthorized();
    error InvalidInput();
    error WrongChain();
    error Ineligible();
    error RestrictedTransfer();
    error PausedError();
    error Frozen();
    error AllocationMismatch();
    error SupplyCap();
    error AlreadyMinted();
    error InsufficientBalance();
    error TerminalSettlement();

    string public constant name = "TEPA Demo Participation Unit";
    string public constant symbol = "TEPA";
    uint8 public constant decimals = 0;
    uint256 public constant MAX_SUPPLY = 1_000;
    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant COMPLIANCE_ROLE = keccak256("COMPLIANCE_ROLE");
    bytes32 public constant ISSUER_AGENT_ROLE = keccak256("ISSUER_AGENT_ROLE");
    bytes32 public constant RECOVERY_ROLE = keccak256("RECOVERY_ROLE");
    bytes32 public constant DISTRIBUTION_ROLE = keccak256("DISTRIBUTION_ROLE");
    bytes32 public constant BUYBACK_ROLE = keccak256("BUYBACK_ROLE");
    bytes32 public constant SETTLEMENT_ROLE = keccak256("SETTLEMENT_ROLE");

    struct Eligibility {
        bytes32 subject;
        bytes32 decision;
        uint64 expiresAt;
        bool active;
    }

    struct Allocation {
        address wallet;
        uint16 units;
        bytes32 caseId;
        bool minted;
    }

    uint256 public immutable deploymentChainId;
    uint256 public totalSupply;
    uint256 public allocatedSupply;
    bool public paused;
    bool public terminalSettlement;
    mapping(bytes32 => mapping(address => bool)) private roles;
    mapping(address => Eligibility) public eligibility;
    mapping(bytes32 => Allocation) public allocations;
    mapping(address => uint256) private balances;
    mapping(address => bool) public isFrozen;
    mapping(address => uint256) public frozenTokens;
    mapping(bytes32 => bool) public usedCases;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event RoleGranted(bytes32 indexed role, address indexed account);
    event RoleRevoked(bytes32 indexed role, address indexed account);
    event EligibilitySet(
        address indexed wallet,
        bytes32 indexed subject,
        bytes32 indexed decision,
        uint64 expiresAt,
        bool active
    );
    event AllocationRecorded(
        bytes32 indexed subject, address indexed wallet, uint256 units, bytes32 indexed caseId
    );
    event Issued(
        bytes32 indexed subject, address indexed wallet, uint256 units, bytes32 indexed caseId
    );
    event Recovery(
        address indexed oldWallet, address indexed newWallet, bytes32 indexed caseId, uint256 units
    );
    event AddressFrozen(address indexed wallet, bool frozen);
    event TokensFrozen(address indexed wallet, uint256 amount);
    event Paused(address indexed actor);
    event Unpaused(address indexed actor);
    event SettlementBurn(address indexed wallet, bytes32 indexed caseId, uint256 units);
    event TerminalSettlementRecorded(address indexed actor);

    constructor(address admin, uint256 chainId) {
        if (
            admin == address(0) || (chainId != 31337 && chainId != 84532)
                || block.chainid != chainId
        ) revert InvalidInput();
        deploymentChainId = chainId;
        roles[DEFAULT_ADMIN_ROLE][admin] = true;
        emit RoleGranted(DEFAULT_ADMIN_ROLE, admin);
    }

    modifier onlyRole(bytes32 role) {
        if (!roles[role][msg.sender]) revert Unauthorized();
        _;
    }

    function hasRole(bytes32 role, address account) external view returns (bool) {
        return roles[role][account];
    }

    function grantRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert InvalidInput();
        roles[role][account] = true;
        emit RoleGranted(role, account);
    }

    function revokeRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        roles[role][account] = false;
        emit RoleRevoked(role, account);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setEligibility(
        address wallet,
        bytes32 subject,
        bytes32 decision,
        uint64 expiresAt,
        bool active
    ) external onlyRole(COMPLIANCE_ROLE) {
        if (
            wallet == address(0) || subject == bytes32(0) || decision == bytes32(0)
                || expiresAt <= block.timestamp
        ) revert InvalidInput();
        if (eligibility[wallet].subject != bytes32(0) && eligibility[wallet].subject != subject) {
            revert Ineligible();
        }
        eligibility[wallet] = Eligibility(subject, decision, expiresAt, active);
        emit EligibilitySet(wallet, subject, decision, expiresAt, active);
    }

    function revokeEligibility(address wallet, bytes32 decision)
        external
        onlyRole(COMPLIANCE_ROLE)
    {
        Eligibility storage record = eligibility[wallet];
        if (record.subject == bytes32(0) || decision == bytes32(0)) revert InvalidInput();
        record.decision = decision;
        record.active = false;
        emit EligibilitySet(wallet, record.subject, decision, record.expiresAt, false);
    }

    function isVerified(address wallet) public view returns (bool) {
        Eligibility memory record = eligibility[wallet];
        return record.active && record.expiresAt > block.timestamp && !isFrozen[wallet]
            && deploymentChainId == block.chainid;
    }

    function setAddressFrozen(address wallet, bool frozen) external onlyRole(COMPLIANCE_ROLE) {
        if (wallet == address(0)) revert InvalidInput();
        isFrozen[wallet] = frozen;
        emit AddressFrozen(wallet, frozen);
    }

    function freezePartialTokens(address wallet, uint256 amount)
        external
        onlyRole(COMPLIANCE_ROLE)
    {
        if (amount == 0 || frozenTokens[wallet] + amount > balances[wallet]) revert InvalidInput();
        frozenTokens[wallet] += amount;
        emit TokensFrozen(wallet, frozenTokens[wallet]);
    }

    function unfreezePartialTokens(address wallet, uint256 amount)
        external
        onlyRole(COMPLIANCE_ROLE)
    {
        if (amount == 0 || amount > frozenTokens[wallet]) revert InvalidInput();
        frozenTokens[wallet] -= amount;
        emit TokensFrozen(wallet, frozenTokens[wallet]);
    }

    function canTransfer(address, address, uint256) external pure returns (bool) {
        return false;
    }

    function balanceOf(address wallet) external view returns (uint256) {
        return balances[wallet];
    }

    function allowance(address, address) external pure returns (uint256) {
        return 0;
    }

    function approve(address, uint256) external pure returns (bool) {
        revert RestrictedTransfer();
    }

    function transfer(address, uint256) external pure returns (bool) {
        revert RestrictedTransfer();
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        revert RestrictedTransfer();
    }

    function recordAllocation(bytes32 subject, address wallet, uint16 units, bytes32 caseId)
        external
        onlyRole(ISSUER_AGENT_ROLE)
    {
        if (
            subject == bytes32(0) || caseId == bytes32(0) || units == 0
                || allocations[subject].wallet != address(0)
        ) revert InvalidInput();
        if (!isVerified(wallet) || eligibility[wallet].subject != subject) revert Ineligible();
        if (allocatedSupply + units > MAX_SUPPLY) revert SupplyCap();
        allocatedSupply += units;
        allocations[subject] = Allocation(wallet, units, caseId, false);
        emit AllocationRecorded(subject, wallet, units, caseId);
    }

    function mint(bytes32 subject, address wallet, uint16 units, bytes32 caseId)
        external
        onlyRole(ISSUER_AGENT_ROLE)
    {
        if (paused) revert PausedError();
        if (terminalSettlement) revert TerminalSettlement();
        Allocation storage allocation = allocations[subject];
        if (allocation.minted) revert AlreadyMinted();
        if (
            allocation.wallet != wallet || allocation.units != units || allocation.caseId != caseId
                || units == 0
        ) revert AllocationMismatch();
        if (!isVerified(wallet) || eligibility[wallet].subject != subject) revert Ineligible();
        if (totalSupply + units > MAX_SUPPLY) revert SupplyCap();
        allocation.minted = true;
        balances[wallet] += units;
        totalSupply += units;
        emit Transfer(address(0), wallet, units);
        emit Issued(subject, wallet, units, caseId);
    }

    function burnForSettlement(address wallet, uint256 units, bytes32 caseId, bool acquisition)
        external
    {
        if (!roles[acquisition ? SETTLEMENT_ROLE : BUYBACK_ROLE][msg.sender]) {
            revert Unauthorized();
        }
        if (paused) revert PausedError();
        if (
            terminalSettlement || wallet == address(0) || units == 0 || caseId == bytes32(0)
                || usedCases[caseId]
        ) revert InvalidInput();
        if (!isVerified(wallet)) revert Ineligible();
        if (balances[wallet] < units || balances[wallet] - frozenTokens[wallet] < units) {
            revert InsufficientBalance();
        }
        usedCases[caseId] = true;
        balances[wallet] -= units;
        totalSupply -= units;
        emit Transfer(wallet, address(0), units);
        emit SettlementBurn(wallet, caseId, units);
    }

    function finalizeAcquisition() external onlyRole(SETTLEMENT_ROLE) {
        if (terminalSettlement || totalSupply != 0) revert InvalidInput();
        terminalSettlement = true;
        emit TerminalSettlementRecorded(msg.sender);
    }

    function recoveryAddress(address oldWallet, address newWallet, bytes32 caseId)
        external
        onlyRole(RECOVERY_ROLE)
        returns (bool)
    {
        if (paused) revert PausedError();
        if (
            caseId == bytes32(0) || usedCases[caseId] || oldWallet == newWallet
                || oldWallet == address(0)
        ) revert InvalidInput();
        Eligibility memory oldRecord = eligibility[oldWallet];
        if (
            oldRecord.subject == bytes32(0) || !isVerified(newWallet)
                || eligibility[newWallet].subject != oldRecord.subject
        ) revert Ineligible();
        uint256 units = balances[oldWallet];
        if (units == 0) revert InsufficientBalance();
        usedCases[caseId] = true;
        balances[oldWallet] = 0;
        balances[newWallet] += units;
        frozenTokens[oldWallet] = 0;
        eligibility[oldWallet].active = false;
        emit Transfer(oldWallet, newWallet, units);
        emit Recovery(oldWallet, newWallet, caseId, units);
        return true;
    }
}
