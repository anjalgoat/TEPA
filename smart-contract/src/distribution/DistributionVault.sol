// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface ITestUsdc {
    function balanceOf(address account) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IEligibleToken {
    function isVerified(address wallet) external view returns (bool);
}

contract DistributionVault {
    error Unauthorized();
    error InvalidInput();
    error WrongChain();
    error InvalidState();
    error InvalidProof();
    error AlreadyClaimed();
    error Ineligible();
    error UnsafeTransfer();

    ITestUsdc public immutable asset;
    IEligibleToken public immutable participationToken;
    bytes32 public immutable epochId;
    bytes32 public immutable entitlementRoot;
    uint256 public immutable committedAmount;
    uint256 public immutable deploymentChainId;
    address public immutable operator;
    bool public claimable;
    uint256 public fundedAmount;
    uint256 public claimedAmount;
    bool private entered;
    mapping(uint256 => bool) public claimed;

    event Funded(bytes32 indexed epochId, uint256 amount, uint256 totalFunded);
    event ClaimsOpened(bytes32 indexed epochId, bytes32 root, uint256 committedAmount);
    event Claimed(
        bytes32 indexed epochId, uint256 indexed index, address indexed wallet, uint256 amount
    );

    constructor(
        address asset_,
        address token_,
        bytes32 epochId_,
        bytes32 root_,
        uint256 committedAmount_,
        address operator_,
        uint256 chainId_
    ) {
        if (
            asset_ == address(0) || token_ == address(0) || operator_ == address(0)
                || epochId_ == bytes32(0) || root_ == bytes32(0) || committedAmount_ == 0
                || asset_.code.length == 0 || token_.code.length == 0
        ) revert InvalidInput();
        if (chainId_ != block.chainid || (chainId_ != 31337 && chainId_ != 84532)) {
            revert WrongChain();
        }
        asset = ITestUsdc(asset_);
        participationToken = IEligibleToken(token_);
        epochId = epochId_;
        entitlementRoot = root_;
        committedAmount = committedAmount_;
        operator = operator_;
        deploymentChainId = chainId_;
    }

    function leaf(uint256 index, address wallet, uint256 amount) public view returns (bytes32) {
        return keccak256(abi.encode(deploymentChainId, epochId, index, wallet, amount));
    }

    function fund(uint256 amount) external {
        if (msg.sender != operator) revert Unauthorized();
        if (block.chainid != deploymentChainId) revert WrongChain();
        if (claimable || entered || amount == 0 || amount > committedAmount - fundedAmount) {
            revert InvalidState();
        }
        entered = true;
        uint256 beforeBalance = asset.balanceOf(address(this));
        if (!asset.transferFrom(msg.sender, address(this), amount)) revert UnsafeTransfer();
        if (asset.balanceOf(address(this)) - beforeBalance != amount) revert UnsafeTransfer();
        fundedAmount += amount;
        entered = false;
        emit Funded(epochId, amount, fundedAmount);
    }

    function openClaims() external {
        if (msg.sender != operator) revert Unauthorized();
        if (block.chainid != deploymentChainId) revert WrongChain();
        if (
            claimable || fundedAmount != committedAmount
                || asset.balanceOf(address(this)) < committedAmount
        ) {
            revert InvalidState();
        }
        claimable = true;
        emit ClaimsOpened(epochId, entitlementRoot, committedAmount);
    }

    function claim(uint256 index, uint256 amount, bytes32[] calldata proof) external {
        if (block.chainid != deploymentChainId) revert WrongChain();
        if (!claimable || amount == 0 || entered) revert InvalidState();
        if (claimed[index]) revert AlreadyClaimed();
        if (!participationToken.isVerified(msg.sender)) revert Ineligible();
        bytes32 node = leaf(index, msg.sender, amount);
        for (uint256 i; i < proof.length; ++i) {
            bytes32 sibling = proof[i];
            node = node < sibling
                ? keccak256(abi.encodePacked(node, sibling))
                : keccak256(abi.encodePacked(sibling, node));
        }
        if (node != entitlementRoot) revert InvalidProof();
        if (claimedAmount + amount > committedAmount) revert InvalidState();
        entered = true;
        claimed[index] = true;
        claimedAmount += amount;
        uint256 beforeBalance = asset.balanceOf(msg.sender);
        if (!asset.transfer(msg.sender, amount)) revert UnsafeTransfer();
        if (asset.balanceOf(msg.sender) - beforeBalance != amount) revert UnsafeTransfer();
        entered = false;
        emit Claimed(epochId, index, msg.sender, amount);
    }
}
