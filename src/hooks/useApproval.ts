import { useCallback, useMemo } from "react";
import { useAccount, usePublicClient, useWalletClient, useReadContract } from "wagmi";
import { erc20Abi } from "../utils/constants";
import type { Address } from "viem";
import { maxUint256, zeroAddress } from "viem";

type UseApprovalParams = {
  token: Address | undefined;
  spender: Address | undefined;
  amount: bigint;
  chainId: number;
  /** Set true when the token is native ETH — approval is never needed. */
  isNative?: boolean;
};

export function useApproval({ token, spender, amount, chainId, isNative }: UseApprovalParams) {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId });
  const { data: walletClient } = useWalletClient({ chainId });

  // Skip allowance read for native ETH or zero-address tokens
  const isErc20 = Boolean(token && token !== zeroAddress && !isNative);

  const { data: allowance, refetch } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: address && spender ? [address, spender] : undefined,
    chainId,
    query: { enabled: Boolean(isErc20 && address && spender) },
  });

  const needsApproval = useMemo(() => {
    if (isNative || !isErc20) return false;
    if (!token || !spender || !address || amount === 0n) return false;
    if (allowance === undefined) return true;
    return (allowance as bigint) < amount;
  }, [isNative, isErc20, token, spender, address, amount, allowance]);

  const approve = useCallback(async () => {
    if (!walletClient || !publicClient || !token || !spender || !address) return;
    // Approve maxUint256 so user doesn't need to re-approve for every amount change
    const hash = await walletClient.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, maxUint256],
      account: address,
      chain: walletClient.chain,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    await refetch();
    return hash;
  }, [walletClient, publicClient, token, spender, address, refetch]);

  return { needsApproval, allowance, approve, refetchAllowance: refetch };
}
