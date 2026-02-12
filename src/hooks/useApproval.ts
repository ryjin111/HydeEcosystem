import { useCallback, useMemo } from "react";
import { useAccount, usePublicClient, useWalletClient, useReadContract } from "wagmi";
import { erc20Abi } from "../utils/constants";
import type { Address } from "viem";

type UseApprovalParams = {
  token: Address | undefined;
  spender: Address | undefined;
  amount: bigint;
  chainId: number;
};

export function useApproval({ token, spender, amount, chainId }: UseApprovalParams) {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId });
  const { data: walletClient } = useWalletClient({ chainId });

  const { data: allowance, refetch } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: address && spender ? [address, spender] : undefined,
    chainId,
    query: { enabled: Boolean(address && token && spender) },
  });

  const needsApproval = useMemo(() => {
    if (!token || !spender || !address || amount === 0n) return false;
    if (allowance === undefined) return true;
    return (allowance as bigint) < amount;
  }, [token, spender, address, amount, allowance]);

  const approve = useCallback(async () => {
    if (!walletClient || !publicClient || !token || !spender || !address) return;
    const hash = await walletClient.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, amount],
      account: address,
      chain: walletClient.chain,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    await refetch();
    return hash;
  }, [walletClient, publicClient, token, spender, address, refetch]);

  return { needsApproval, allowance, approve, refetchAllowance: refetch };
}
