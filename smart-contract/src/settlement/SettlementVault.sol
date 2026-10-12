// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface ISettlementAsset {
    function balanceOf(address account) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface ISettlementToken {
    function isVerified(address wallet) external view returns (bool);
    function balanceOf(address wallet) external view returns (uint256);
    function burnForSettlement(address wallet, uint256 units, bytes32 caseId, bool acquisition)
        external;
    function finalizeAcquisition() external;
}

/// @notice One immutable, funded demo commitment for a buyback or acquisition.
contract SettlementVault {
    error Unauthorized();
    error InvalidInput();
    error WrongChain();
    error InvalidState();
    error InvalidProof();
    error AlreadySettled();
    error Ineligible();
    error UnsafeTransfer();

    ISettlementAsset public immutable asset;
    ISettlementToken public immutable participationToken;
    bytes32 public immutable settlementId;
    bytes32 public immutable entitlementRoot;
    uint256 public immutable committedAmount;
    uint256 public immutable committedUnits;
    uint256 public immutable deploymentChainId;
    address public immutable operator;
    bool public immutable acquisition;
    bool public open;
    bool public finalized;
    uint256 public fundedAmount;
    uint256 public paidAmount;
    uint256 public burnedUnits;
    bool private entered;
    mapping(uint256 => bool) public settled;

    event Funded(bytes32 indexed settlementId, uint256 amount, uint256 totalFunded);
    event Opened(bytes32 indexed settlementId, bytes32 root, uint256 committedAmount);
    event PaidAndBurned(
        bytes32 indexed settlementId,
        uint256 indexed index,
        address indexed wallet,
        uint256 units,
        uint256 amount
    );
    event Finalized(bytes32 indexed settlementId);

    constructor(
        address asset_,
        address token_,
        bytes32 settlementId_,
        bytes32 root_,
        uint256 committedAmount_,
        uint256 committedUnits_,
        address operator_,
        uint256 chainId_,
        bool acquisition_
    ) {
        if (
            asset_ == address(0) || token_ == address(0) || operator_ == address(0)
                || asset_.code.length == 0 || token_.code.length == 0 || settlementId_ == bytes32(0)
                || root_ == bytes32(0) || committedAmount_ == 0 || committedUnits_ == 0
        ) {
            revert InvalidInput();
        }
        if (chainId_ != block.chainid || (chainId_ != 31337 && chainId_ != 84532)) {
            revert WrongChain();
        }
        asset = ISettlementAsset(asset_);
        participationToken = ISettlementToken(token_);
        settlementId = settlementId_;
        entitlementRoot = root_;
        committedAmount = committedAmount_;
        committedUnits = committedUnits_;
        operator = operator_;
        deploymentChainId = chainId_;
        acquisition = acquisition_;
    }

    function leaf(uint256 index, address wallet, uint256 units, uint256 amount)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(deploymentChainId, settlementId, acquisition, index, wallet, units, amount)
        );
    }

    function fund(uint256 amount) external {
        if (msg.sender != operator) revert Unauthorized();
        if (block.chainid != deploymentChainId) revert WrongChain();
        if (open || entered || amount == 0 || amount > committedAmount - fundedAmount) {
            revert InvalidState();
        }
        entered = true;
        uint256 beforeBalance = asset.balanceOf(address(this));
        if (!asset.transferFrom(msg.sender, address(this), amount)) revert UnsafeTransfer();
        if (asset.balanceOf(address(this)) - beforeBalance != amount) revert UnsafeTransfer();
        fundedAmount += amount;
        entered = false;
        emit Funded(settlementId, amount, fundedAmount);
    }

    function openSettlement() external {
        if (msg.sender != operator) revert Unauthorized();
        if (block.chainid != deploymentChainId) revert WrongChain();
        if (
            open || fundedAmount != committedAmount
                || asset.balanceOf(address(this)) < committedAmount
        ) {
            revert InvalidState();
        }
        open = true;
        emit Opened(settlementId, entitlementRoot, committedAmount);
    }

    function settle(uint256 index, uint256 units, uint256 amount, bytes32[] calldata proof)
        external
    {
        if (block.chainid != deploymentChainId) revert WrongChain();
        if (!open || finalized || entered || units == 0 || amount == 0) revert InvalidState();
        if (settled[index]) revert AlreadySettled();
        if (
            !participationToken.isVerified(msg.sender)
                || participationToken.balanceOf(msg.sender) < units
        ) {
            revert Ineligible();
        }
        bytes32 node = leaf(index, msg.sender, units, amount);
        for (uint256 i; i < proof.length; ++i) {
            bytes32 sibling = proof[i];
            node = node < sibling
                ? keccak256(abi.encodePacked(node, sibling))
                : keccak256(abi.encodePacked(sibling, node));
        }
        if (node != entitlementRoot) revert InvalidProof();
        if (paidAmount + amount > committedAmount || burnedUnits + units > committedUnits) {
            revert InvalidState();
        }
        entered = true;
        settled[index] = true;
        paidAmount += amount;
        burnedUnits += units;
        bytes32 caseId =
            keccak256(abi.encode(deploymentChainId, address(this), settlementId, index));
        participationToken.burnForSettlement(msg.sender, units, caseId, acquisition);
        uint256 beforeBalance = asset.balanceOf(msg.sender);
        if (!asset.transfer(msg.sender, amount)) revert UnsafeTransfer();
        if (asset.balanceOf(msg.sender) - beforeBalance != amount) revert UnsafeTransfer();
        entered = false;
        emit PaidAndBurned(settlementId, index, msg.sender, units, amount);
    }

    function finalize() external {
        if (msg.sender != operator) revert Unauthorized();
        if (!open || finalized || paidAmount != committedAmount || burnedUnits != committedUnits) {
            revert InvalidState();
        }
        finalized = true;
        if (acquisition) participationToken.finalizeAcquisition();
        emit Finalized(settlementId);
    }
}
