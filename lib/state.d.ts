import { UserAccount } from 'libzeropool-rs-wasm-web';
export declare class ZeroPoolState {
    denominator: bigint;
    account: UserAccount;
    static create(sk: Uint8Array, networkName: string, denominator: bigint): Promise<ZeroPoolState>;
    getTotalBalance(): string;
    getBalances(): [string, string, string];
    rawState(): any;
    free(): void;
}
