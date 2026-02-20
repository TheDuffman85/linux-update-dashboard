import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { useUpgradeAll, useUpgradePackage } from "../lib/updates";

interface UpgradeEntry {
  type: "all" | "package";
  packageName?: string;
}

interface UpgradeCallbacks {
  onSuccess?: (data: any) => void;
  onError?: (err: Error) => void;
}

interface UpgradeContextType {
  upgradingSystems: Map<number, UpgradeEntry>;
  upgradeAll: (systemId: number, callbacks?: UpgradeCallbacks) => void;
  upgradePackage: (
    systemId: number,
    packageName: string,
    callbacks?: UpgradeCallbacks
  ) => void;
  isUpgrading: (systemId: number) => boolean;
  upgradingCount: number;
}

const UpgradeContext = createContext<UpgradeContextType | null>(null);

export function UpgradeProvider({ children }: { children: ReactNode }) {
  const [upgradingSystems, setUpgradingSystems] = useState<
    Map<number, UpgradeEntry>
  >(new Map());

  const upgradeAllMutation = useUpgradeAll();
  const upgradePackageMutation = useUpgradePackage();

  const addUpgrading = useCallback(
    (systemId: number, entry: UpgradeEntry) => {
      setUpgradingSystems((prev) => new Map(prev).set(systemId, entry));
    },
    []
  );

  const removeUpgrading = useCallback((systemId: number) => {
    setUpgradingSystems((prev) => {
      const next = new Map(prev);
      next.delete(systemId);
      return next;
    });
  }, []);

  const upgradeAll = useCallback(
    (systemId: number, callbacks?: UpgradeCallbacks) => {
      addUpgrading(systemId, { type: "all" });
      upgradeAllMutation.mutate(systemId, {
        onSuccess: (data) => {
          removeUpgrading(systemId);
          callbacks?.onSuccess?.(data);
        },
        onError: (err) => {
          removeUpgrading(systemId);
          callbacks?.onError?.(err);
        },
      });
    },
    [upgradeAllMutation, addUpgrading, removeUpgrading]
  );

  const upgradePackage = useCallback(
    (systemId: number, packageName: string, callbacks?: UpgradeCallbacks) => {
      addUpgrading(systemId, { type: "package", packageName });
      upgradePackageMutation.mutate(
        { systemId, packageName },
        {
          onSuccess: (data) => {
            removeUpgrading(systemId);
            callbacks?.onSuccess?.(data);
          },
          onError: (err) => {
            removeUpgrading(systemId);
            callbacks?.onError?.(err);
          },
        }
      );
    },
    [upgradePackageMutation, addUpgrading, removeUpgrading]
  );

  const isUpgrading = useCallback(
    (systemId: number) => upgradingSystems.has(systemId),
    [upgradingSystems]
  );

  return (
    <UpgradeContext.Provider
      value={{
        upgradingSystems,
        upgradeAll,
        upgradePackage,
        isUpgrading,
        upgradingCount: upgradingSystems.size,
      }}
    >
      {children}
    </UpgradeContext.Provider>
  );
}

export function useUpgrade() {
  const ctx = useContext(UpgradeContext);
  if (!ctx)
    throw new Error("useUpgrade must be used within UpgradeProvider");
  return ctx;
}
