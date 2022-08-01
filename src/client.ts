import { validateAddress, Output, Proof, DecryptedMemo, ITransferData, IWithdrawData } from 'libzkbob-rs-wasm-web';

import { SnarkParams, Tokens } from './config';
import { hexToBuf, toCompactSignature, truncateHexPrefix } from './utils';
import { ZkBobState } from './state';
import { TxType } from './tx';
import { NetworkBackend } from './networks/network';
import { CONSTANTS } from './constants';
import { HistoryRecord, HistoryTransactionType } from './history'
import { IndexedTx } from 'libzkbob-rs-wasm-web';

const MIN_TX_AMOUNT = BigInt(10000000);
const TX_FEE = BigInt(10000000);

export interface RelayerInfo {
  root: string;
  deltaIndex: string;
}

export interface BatchResult {
  txCount: number;
  maxMinedIndex: number;
  maxPendingIndex: number;
}

export interface TxAmount { // all values are in Gwei
  amount: bigint;  // tx amount (without fee)
  fee: bigint;  // fee 
  accountLimit: bigint;  // minimum account remainder after transaction
                         // (used for complex multi-tx transfers, default: 0)
}

export interface TxToRelayer {
  txType: TxType;
  memo: string;
  proof: Proof;
  depositSignature?: string
}

export interface FeeAmount { // all values are in Gwei
  total: bigint;    // total fee
  totalPerTx: bigint; // multitransfer case (== total for regular tx)
  txCnt: number;      // multitransfer case (== 1 for regular tx)
  relayer: bigint;  // relayer fee component
  l1: bigint;       // L1 fee component
}

async function fetchTransactions(relayerUrl: string, offset: BigInt, limit: number = 100): Promise<string[]> {
  const url = new URL(`/transactions`, relayerUrl);
  url.searchParams.set('limit', limit.toString());
  url.searchParams.set('offset', offset.toString());
  const headers = {'content-type': 'application/json;charset=UTF-8'};
  const res = await (await fetch(url.toString(), {headers})).json();

  return res;
}

async function fetchTransactionsOptimistic(relayerUrl: string, offset: BigInt, limit: number = 100): Promise<string[]> {
  const url = new URL(`/transactions/v2`, relayerUrl);
  url.searchParams.set('limit', limit.toString());
  url.searchParams.set('offset', offset.toString());
  const headers = {'content-type': 'application/json;charset=UTF-8'};
  const res = await (await fetch(url.toString(), {headers})).json();  

  return res;
}

// returns transaction job ID
async function sendTransactions(relayerUrl: string, txs: TxToRelayer[]): Promise<string> {
  const url = new URL('/sendTransactions', relayerUrl);
  const headers = {'content-type': 'application/json;charset=UTF-8'};
  const res = await fetch(url.toString(), { method: 'POST', headers, body: JSON.stringify(txs) });

  if (!res.ok) {
    const body = await res.json();
    throw new Error(`Error ${res.status}: ${JSON.stringify(body)}`)
  }

  const json = await res.json();
  return json.jobId;
}

async function getJob(relayerUrl: string, id: string): Promise<{ state: string, txHash: string[] } | null> {
  const url = new URL(`/job/${id}`, relayerUrl);
  const headers = {'content-type': 'application/json;charset=UTF-8'};
  const res = await (await fetch(url.toString(), {headers})).json();

  if (typeof res === 'string') {
    return null;
  } else {
    return res;
  }
}

async function info(relayerUrl: string): Promise<RelayerInfo> {
  const url = new URL('/info', relayerUrl);
  const headers = {'content-type': 'application/json;charset=UTF-8'};
  const res = await fetch(url.toString(), {headers});

  return await res.json();
}

export interface ClientConfig {
  /** Spending key. */
  sk: Uint8Array;
  /** A map of supported tokens (token address => token params). */
  tokens: Tokens;
  /** Loaded zkSNARK paramaterers. */
  snarkParams: SnarkParams;
  /** A worker instance acquired through init() function of this package. */
  worker: any;
  /** The name of the network is only used for storage. */
  networkName: string | undefined;
  network: NetworkBackend;
}

export class ZkBobClient {
  private zpStates: { [tokenAddress: string]: ZkBobState };
  private worker: any;
  private snarkParams: SnarkParams;
  private tokens: Tokens;
  private config: ClientConfig;
  private relayerFee: bigint | undefined; // in Gwei, do not use directly, use getRelayerFee method instead
  private updateStatePromise: Promise<boolean> | undefined;

  public static async create(config: ClientConfig): Promise<ZkBobClient> {
    const client = new ZkBobClient();
    client.zpStates = {};
    client.worker = config.worker;
    client.snarkParams = config.snarkParams;
    client.tokens = config.tokens;
    client.config = config;

    client.relayerFee = undefined;

    let networkName = config.networkName;
    if (!networkName) {
      networkName = config.network.defaultNetworkName();
    }

    for (const [address, token] of Object.entries(config.tokens)) {
      const denominator = await config.network.getDenominator(token.poolAddress);
      client.zpStates[address] = await ZkBobState.create(config.sk, networkName, config.network.getRpcUrl(), BigInt(denominator));
    }

    return client;
  }

  public free(): void {
    for (let state of Object.values(this.zpStates)) {
      state.free();
    }
  }

  // ------------------=========< Balances and History >=========-------------------
  // | Quering shielded balance and history records                                |
  // -------------------------------------------------------------------------------

  // Pool contract using default denominator 10^9
  // i.e. values less than 1 Gwei are supposed equals zero
  // But this is deployable parameter so this method are using to retrieve it
  public getDenominator(tokenAddress: string): bigint {
    return this.zpStates[tokenAddress].denominator;
  }

  // Convert native pool amount to the base units
  public shieldedAmountToWei(tokenAddress, amountGwei: bigint): bigint {
    return amountGwei * this.zpStates[tokenAddress].denominator
  }
  
  // Convert base units to the native pool amount
  public weiToShieldedAmount(tokenAddress, amountWei: bigint): bigint {
    return amountWei / this.zpStates[tokenAddress].denominator
  }

  // Get account + notes balance in Gwei
  // [with optional state update]
  public async getTotalBalance(tokenAddress: string, updateState: boolean = true): Promise<bigint> {
    if (updateState) {
      await this.updateState(tokenAddress);
    }

    return this.zpStates[tokenAddress].getTotalBalance();
  }

  // Get total balance with components: account and notes
  // [with optional state update]
  // Returns [total, account, note] in Gwei
  public async getBalances(tokenAddress: string, updateState: boolean = true): Promise<[bigint, bigint, bigint]> {
    if (updateState) {
      await this.updateState(tokenAddress);
    }

    return this.zpStates[tokenAddress].getBalances();
  }

  // Get total balance including transactions in optimistic state [in Gwei]
  // There is no option to prevent state update here,
  // because we should always monitor optimistic state
  public async getOptimisticTotalBalance(tokenAddress: string): Promise<bigint> {
    const state = this.zpStates[tokenAddress];

    const confirmedBalance = await this.getTotalBalance(tokenAddress);
    const historyRecords = await this.getAllHistory(tokenAddress);

    let pendingDelta = BigInt(0);
    for (const oneRecord of historyRecords) {
      if (oneRecord.pending) {
        switch (oneRecord.type) {
          case HistoryTransactionType.Deposit:
          case HistoryTransactionType.TransferIn: {
            // we don't spend fee from the shielded balance in case of deposit or input transfer
            pendingDelta += oneRecord.amount;
            break;
          }
          case HistoryTransactionType.Withdrawal:
          case HistoryTransactionType.TransferOut: {
            pendingDelta -= (oneRecord.amount + oneRecord.fee);
            break;
          }

          default: break;
        }
      }
    }

    return confirmedBalance + pendingDelta;
  }

  // Get history records
  public async getAllHistory(tokenAddress: string, updateState: boolean = true): Promise<HistoryRecord[]> {
    if (updateState) {
      await this.updateState(tokenAddress);
    }

    return await this.zpStates[tokenAddress].history.getAllHistory();
  }

  // ------------------=========< Service Routines >=========-------------------
  // | Methods for creating and sending transactions in different modes        |
  // ---------------------------------------------------------------------------

  // Generate shielded address to receive funds
  public generateAddress(tokenAddress: string): string {
    const state = this.zpStates[tokenAddress];
    return state.account.generateAddress();
  }

  // Waiting while relayer process the job
  // return transaction(s) hash(es) on success or throw an error
  public async waitJobCompleted(tokenAddress: string, jobId: string): Promise<string[]> {
    const token = this.tokens[tokenAddress];

    const INTERVAL_MS = 1000;
    let hashes: string[];
    while (true) {
      const job = await getJob(token.relayerUrl, jobId);

      if (job === null) {
        console.error(`Job ${jobId} not found.`);
        throw new Error(`Job ${jobId} not found`);
      } else if (job.state === 'failed') {
        throw new Error(`Transaction [job ${jobId}] failed`);
      } else if (job.state === 'completed') {
        hashes = job.txHash;
        break;
      }

      await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
    }

    console.info(`Transaction [job ${jobId}] successful: ${hashes.join(", ")}`);

    return hashes;
  }

  // ------------------=========< Making Transactions >=========-------------------
  // | Methods for creating and sending transactions in different modes           |
  // ------------------------------------------------------------------------------

  // Deposit based on permittable token scheme. User should sign typed data to allow
  // contract receive his tokens
  // Returns jobId from the relayer or throw an Error
  public async depositPermittable(
    tokenAddress: string,
    amountGwei: bigint,
    signTypedData: (deadline: bigint, value: bigint) => Promise<string>,
    fromAddress: string | null = null,
    feeGwei: bigint = BigInt(0),
  ): Promise<string> {
    const token = this.tokens[tokenAddress];
    const state = this.zpStates[tokenAddress];

    if (amountGwei < MIN_TX_AMOUNT) {
      throw new Error(`Deposit is too small (less than ${MIN_TX_AMOUNT.toString()})`);
    }

    await this.updateState(tokenAddress);

    let txData;
    if (fromAddress) {
      const deadline:bigint = BigInt(Math.floor(Date.now() / 1000) + 900)
      const holder = hexToBuf(fromAddress);
      txData = await state.account.createDepositPermittable({ 
        amount: (amountGwei + feeGwei).toString(),
        fee: feeGwei.toString(),
        deadline: String(deadline),
        holder
      });

      const startProofDate = Date.now();
      const txProof = await this.worker.proveTx(txData.public, txData.secret);
      const proofTime = (Date.now() - startProofDate) / 1000;
      console.log(`Proof calculation took ${proofTime.toFixed(1)} sec`);

      const txValid = Proof.verify(this.snarkParams.transferVk!, txProof.inputs, txProof.proof);
      if (!txValid) {
        throw new Error('invalid tx proof');
      }

      // permittable deposit signature should be calculated for the typed data
      const value = (amountGwei + feeGwei) * state.denominator;
      let signature = truncateHexPrefix(await signTypedData(deadline, value));

      if (this.config.network.isSignatureCompact()) {
        signature = toCompactSignature(signature);
      }

      let tx = { txType: TxType.BridgeDeposit, memo: txData.memo, proof: txProof, depositSignature: signature };
      return await sendTransactions(token.relayerUrl, [tx]);

    } else {
      throw new Error('You must provide fromAddress for bridge deposit transaction ');
    }
  }

  // Transfer shielded funds to the shielded address
  // This method can produce several transactions in case of insufficient input notes (constants::IN per tx)
  // // Returns jobId from the relayer or throw an Error
  public async transferMulti(tokenAddress: string, to: string, amountGwei: bigint, feeGwei: bigint = BigInt(0)): Promise<string> {
    const state = this.zpStates[tokenAddress];
    const token = this.tokens[tokenAddress];

    if (!validateAddress(to)) {
      throw new Error('Invalid address. Expected a shielded address.');
    }

    if (amountGwei < MIN_TX_AMOUNT) {
      throw new Error(`Transfer amount is too small (less than ${MIN_TX_AMOUNT.toString()})`);
    }

    const txParts = await this.getTransactionParts(tokenAddress, amountGwei, feeGwei);

    if (txParts.length == 0) {
      throw new Error('Cannot find appropriate multitransfer configuration (insufficient funds?)');
    }

    const transfers = txParts.map(({amount, fee, accountLimit}) => {
      const oneTransfer: ITransferData = {
        outputs: [{to, amount: amount.toString()}],
        fee: fee.toString(),
      };

      return oneTransfer;
    });

    const txsData = await state.account.createMultiTransfer(transfers);

    const txPromises: Promise<TxToRelayer>[] = txsData.map(async (transfer) => {
      const startProofDate = Date.now();
      const txProof: Proof = await this.worker.proveTx(transfer.public, transfer.secret);
      const proofTime = (Date.now() - startProofDate) / 1000;
      console.log(`Proof calculation took ${proofTime.toFixed(1)} sec`);

      const txValid = Proof.verify(this.snarkParams.transferVk!, txProof.inputs, txProof.proof);
      if (!txValid) {
        throw new Error('invalid tx proof');
      }

      return {memo: transfer.memo, proof: txProof, txType: TxType.Transfer};
    });

    const txs = await Promise.all(txPromises);

    let jobId = await sendTransactions(token.relayerUrl, txs);
    
    return jobId;
  }

  // Withdraw shielded funds to the specified native chain address
  // This method can produce several transactions in case of insufficient input notes (constants::IN per tx)
  // feeGwei - fee per single transaction (request it with atomicTxFee method)
  // Returns jobId from the relayer or throw an Error
  public async withdrawMulti(tokenAddress: string, address: string, amountGwei: bigint, feeGwei: bigint = BigInt(0)): Promise<string> {
    const token = this.tokens[tokenAddress];
    const state = this.zpStates[tokenAddress];

    if (amountGwei < MIN_TX_AMOUNT) {
      throw new Error(`Withdraw amount is too small (less than ${MIN_TX_AMOUNT.toString()})`);
    }

    const txParts = await this.getTransactionParts(tokenAddress, amountGwei, feeGwei);

    if (txParts.length == 0) {
      throw new Error('Cannot find appropriate multitransfer configuration (insufficient funds?)');
    }

    const addressBin = hexToBuf(address);

    const transfers = txParts.map(({amount, fee, accountLimit}) => {
      const oneTransfer: IWithdrawData = {
        amount: amount.toString(),
        fee: fee.toString(),
        to: addressBin,
        native_amount: '0',
        energy_amount: '0',
      };

      return oneTransfer;
    });

    const txsData = await state.account.createMultiWithdraw(transfers);

    const txPromises: Promise<TxToRelayer>[] = txsData.map(async (transfer) => {
      const startProofDate = Date.now();
      const txProof: Proof = await this.worker.proveTx(transfer.public, transfer.secret);
      const proofTime = (Date.now() - startProofDate) / 1000;
      console.log(`Proof calculation took ${proofTime.toFixed(1)} sec`);

      const txValid = Proof.verify(this.snarkParams.transferVk!, txProof.inputs, txProof.proof);
      if (!txValid) {
        throw new Error('invalid tx proof');
      }

      return {memo: transfer.memo, proof: txProof, txType: TxType.Withdraw};
    });

    const txs = await Promise.all(txPromises);

    let jobId = await sendTransactions(token.relayerUrl, txs);
    
    return jobId;
  }

  // DEPRECATED. Please use depositPermittable method instead
  // Deposit throught approval allowance
  // User should approve allowance for contract address at least 
  // (amountGwei + feeGwei) tokens before calling this method
  // Returns jobId
  public async deposit(
    tokenAddress: string,
    amountGwei: bigint,
    sign: (data: string) => Promise<string>,
    fromAddress: string | null = null,
    feeGwei: bigint = BigInt(0),
  ): Promise<string> {
    const token = this.tokens[tokenAddress];
    const state = this.zpStates[tokenAddress];

    if (amountGwei < MIN_TX_AMOUNT) {
      throw new Error(`Deposit is too small (less than ${MIN_TX_AMOUNT.toString()})`);
    }

    await this.updateState(tokenAddress);

    let txData = await state.account.createDeposit({
      amount: (amountGwei + feeGwei).toString(),
      fee: feeGwei.toString(),
    });

    const startProofDate = Date.now();
    const txProof = await this.worker.proveTx(txData.public, txData.secret);
    const proofTime = (Date.now() - startProofDate) / 1000;
    console.log(`Proof calculation took ${proofTime.toFixed(1)} sec`);

    const txValid = Proof.verify(this.snarkParams.transferVk!, txProof.inputs, txProof.proof);
    if (!txValid) {
      throw new Error('invalid tx proof');
    }

    // regular deposit through approve allowance: sign transaction nullifier
    let dataToSign = '0x' + BigInt(txData.public.nullifier).toString(16).padStart(64, '0');

    // TODO: Sign fromAddress as well?
    const signature = truncateHexPrefix(await sign(dataToSign));
    let fullSignature = signature;
    if (fromAddress) {
      const addr = truncateHexPrefix(fromAddress);
      fullSignature = addr + signature;
    }

    if (this.config.network.isSignatureCompact()) {
      fullSignature = toCompactSignature(fullSignature);
    }

    let tx = { txType: TxType.Deposit, memo: txData.memo, proof: txProof, depositSignature: fullSignature };

    return await sendTransactions(token.relayerUrl, [tx]);
  }

  // DEPRECATED. Please use transferMulti method instead
  // Simple transfer to the shielded address. Supports several output addresses
  // This method will fail when insufficent input notes (constants::IN) for transfer
  public async transferSingle(tokenAddress: string, outsGwei: Output[], feeGwei: bigint = BigInt(0)): Promise<string> {
    await this.updateState(tokenAddress);

    const token = this.tokens[tokenAddress];
    const state = this.zpStates[tokenAddress];

    const outGwei = outsGwei.map(({ to, amount }) => {
      if (!validateAddress(to)) {
        throw new Error('Invalid address. Expected a shielded address.');
      }

      if (BigInt(amount) < MIN_TX_AMOUNT) {
        throw new Error(`One of the values is too small (less than ${MIN_TX_AMOUNT.toString()})`);
      }

      return { to, amount };
    });

    const txData = await state.account.createTransfer({ outputs: outGwei, fee: feeGwei.toString() });

    const startProofDate = Date.now();
    const txProof = await this.worker.proveTx(txData.public, txData.secret);
    const proofTime = (Date.now() - startProofDate) / 1000;
    console.log(`Proof calculation took ${proofTime.toFixed(1)} sec`);

    const txValid = Proof.verify(this.snarkParams.transferVk!, txProof.inputs, txProof.proof);
    if (!txValid) {
      throw new Error('invalid tx proof');
    }

    let tx = { txType: TxType.Transfer, memo: txData.memo, proof: txProof };
    return await sendTransactions(token.relayerUrl, [tx]);
  }

  // DEPRECATED. Please use withdrawMulti methos instead
  // Simple withdraw to the native address
  // This method will fail when insufficent input notes (constants::IN) for withdrawal
  public async withdrawSingle(tokenAddress: string, address: string, amountGwei: bigint, feeGwei: bigint = BigInt(0)): Promise<string> {
    const token = this.tokens[tokenAddress];
    const state = this.zpStates[tokenAddress];

    if (amountGwei < MIN_TX_AMOUNT) {
      throw new Error(`Withdraw amount is too small (less than ${MIN_TX_AMOUNT.toString()})`);
    }

    await this.updateState(tokenAddress);

    const txType = TxType.Withdraw;
    const addressBin = hexToBuf(address);

    const txData = await state.account.createWithdraw({
      amount: (amountGwei + feeGwei).toString(),
      to: addressBin,
      fee: feeGwei.toString(),
      native_amount: '0',
      energy_amount: '0'
    });

    const startProofDate = Date.now();
    const txProof = await this.worker.proveTx(txData.public, txData.secret);
    const proofTime = (Date.now() - startProofDate) / 1000;
    console.log(`Proof calculation took ${proofTime.toFixed(1)} sec`);
    
    const txValid = Proof.verify(this.snarkParams.transferVk!, txProof.inputs, txProof.proof);
    if (!txValid) {
      throw new Error('invalid tx proof');
    }

    let tx = { txType: TxType.Withdraw, memo: txData.memo, proof: txProof };
    return await sendTransactions(token.relayerUrl, [tx]);
  }


  // ------------------=========< Transaction configuration >=========-------------------
  // | These methods includes fee estimation, multitransfer estimation and other inform |
  // | functions.                                                                       |
  // ------------------------------------------------------------------------------------

  // Min trensaction fee in Gwei (e.g. deposit or single transfer)
  // To estimate fee in the common case please use feeEstimate instead
  public async atomicTxFee(tokenAddress: string): Promise<bigint> {
    const relayer = await this.getRelayerFee(tokenAddress);
    const l1 = BigInt(0);

    return relayer + l1;
  }

  // Fee can depends on tx amount for multitransfer transactions,
  // that's why you should specify it here for general case
  // This method also supposed that in some cases fee can depends on tx amount in future
  // Currently deposit isn't depends of amount
  public async feeEstimate(tokenAddress: string, amountGwei: bigint, txType: TxType, updateState: boolean = true): Promise<FeeAmount> {
    const relayer = await this.getRelayerFee(tokenAddress);
    const l1 = BigInt(0);
    let txCnt = 1;
    let totalPerTx = relayer + l1;
    let total = totalPerTx;
    if (txType === TxType.Transfer || txType === TxType.Withdraw) {
      const parts = await this.getTransactionParts(tokenAddress, amountGwei, totalPerTx, updateState);
      if (parts.length == 0) {
        throw new Error(`insufficient funds`);
      }

      txCnt = parts.length;
      total = totalPerTx * BigInt(txCnt);
    }
    return {total, totalPerTx, txCnt, relayer, l1};
  }

  // Relayer fee component. Do not use it directly
  private async getRelayerFee(tokenAddress: string): Promise<bigint> {
    if (this.relayerFee === undefined) {
      // TODO: fetch actual fee from the relayer
      this.relayerFee = TX_FEE;
    }

    return this.relayerFee;
  }

  // Account + notes balance excluding fee needed to transfer or withdraw it
  public async calcMaxAvailableTransfer(tokenAddress: string, updateState: boolean = true): Promise<bigint> {
    const state = this.zpStates[tokenAddress];
    if (updateState) {
      await this.updateState(tokenAddress);
    }

    let result: bigint;

    const txFee = await this.atomicTxFee(tokenAddress);
    const usableNotes = state.usableNotes();
    const accountBalance = BigInt(state.accountBalance());
    let notesBalance = BigInt(0);

    let txCnt = 1;
    if (usableNotes.length > CONSTANTS.IN) {
      txCnt += Math.ceil((usableNotes.length - CONSTANTS.IN) / CONSTANTS.IN);
    }

    for(let i = 0; i < usableNotes.length; i++) {
      const curNote = usableNotes[i][1];
      notesBalance += BigInt(curNote.b)
    }

    let summ = accountBalance + notesBalance - txFee * BigInt(txCnt);
    if (summ < 0) {
      summ = BigInt(0);
    }

    return summ;
  }

  // Calculate multitransfer configuration for specified token amount and fee per transaction
  // Applicable for transfer and withdrawal transactions. You can prevent state updating with updateState flag
  public async getTransactionParts(tokenAddress: string, amountGwei: bigint, feeGwei: bigint, updateState: boolean = true): Promise<Array<TxAmount>> {
    const state = this.zpStates[tokenAddress];
    if (updateState) {
      await this.updateState(tokenAddress);
    }

    let result: Array<TxAmount> = [];

    const usableNotes = state.usableNotes();
    const accountBalance = BigInt(state.accountBalance());

    let remainAmount = amountGwei;

    if (accountBalance >= remainAmount + feeGwei) {
      result.push({amount: remainAmount, fee: feeGwei, accountLimit: BigInt(0)});
    } else {
      let notesParts: Array<bigint> = [];
      let curPart = BigInt(0);
      for(let i = 0; i < usableNotes.length; i++) {
        const curNote = usableNotes[i][1];

        if (i > 0 && i % CONSTANTS.IN == 0) {
          notesParts.push(curPart);
          curPart = BigInt(0);
        }

        curPart += BigInt(curNote.b);

        if (i == usableNotes.length - 1) {
          notesParts.push(curPart);
        }
      }

      let oneTxPart = accountBalance;

      for(let i = 0; i < notesParts.length && remainAmount > 0; i++) {
        oneTxPart += notesParts[i];
        if (oneTxPart - feeGwei > remainAmount) {
          oneTxPart = remainAmount + feeGwei;
        }

        if(oneTxPart < feeGwei || oneTxPart < MIN_TX_AMOUNT) {
          break;
        }

        result.push({amount: oneTxPart - feeGwei, fee: feeGwei, accountLimit: BigInt(0)});

        remainAmount -= (oneTxPart - feeGwei);
        oneTxPart = BigInt(0);
      }

      if(remainAmount > 0){
        result = [];
      }
    }

    return result;
  }

  // ------------------=========< State Processing >=========-------------------
  // | Updating and monitoring state                                            |
  // ----------------------------------------------------------------------------

  // The library can't make any transfers when there are outcoming
  // transactions in the optimistic state
  public async isReadyToTransact(tokenAddress: string): Promise<boolean> {
    return await this.updateState(tokenAddress);
  }

  // Wait while state becomes ready to make new transactions
  public async waitReadyToTransact(tokenAddress: string): Promise<boolean> {
    const token = this.tokens[tokenAddress];

    const INTERVAL_MS = 1000;
    const MAX_ATTEMPTS = 300;
    let attepts = 0;
    while (true) {
      let ready = await this.updateState(tokenAddress);

      if (ready) {
        break;
      }

      attepts++;
      if (attepts > MAX_ATTEMPTS) {
        return false;
      }

      await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
    }

    return true;
  }

  // Getting array of accounts and notes for the current account
  public async rawState(tokenAddress: string): Promise<any> {
    return await this.zpStates[tokenAddress].rawState();
  }
  

  // TODO: implement correct state cleaning
  public async cleanState(tokenAddress: string): Promise<void> {
    await this.zpStates[tokenAddress].clean();
  }

  // Request the latest state from the relayer
  // Returns isReadyToTransact flag
  public async updateState(tokenAddress: string): Promise<boolean> {
    if (this.updateStatePromise == undefined) {
      this.updateStatePromise = this.updateStateOptimisticWorker(tokenAddress).finally(() => {
        this.updateStatePromise = undefined;
      });
    } else {
      console.info(`The state currently updating, waiting for finish...`);
    }

    return this.updateStatePromise;
  }

  // ---===< TODO >===---
  // The optimistic state currently processed only in the client library
  // Wasm package holds only the mined transactions
  // Currently it's just a workaround
  private async updateStateOptimisticWorker(tokenAddress: string): Promise<boolean> {
    const OUTPLUSONE = CONSTANTS.OUT + 1;
    const BATCH_SIZE = 10000;

    const zpState = this.zpStates[tokenAddress];
    const token = this.tokens[tokenAddress];
    const state = this.zpStates[tokenAddress];

    const startIndex = Number(zpState.account.nextTreeIndex());
    const nextIndex = Number((await info(token.relayerUrl)).deltaIndex);
    // TODO: it's just a workaroud while relayer doesn't return optimistic index!
    const optimisticIndex = nextIndex + 1;

    if (optimisticIndex > startIndex) {
      const startTime = Date.now();
      
      console.log(`⬇ Fetching transactions between ${startIndex} and ${nextIndex}...`);

      
      let batches: Promise<BatchResult>[] = [];

      let readyToTransact = true;

      for (let i = startIndex; i <= nextIndex; i = i + BATCH_SIZE * OUTPLUSONE) {
        let oneBatch = fetchTransactionsOptimistic(token.relayerUrl, BigInt(i), BATCH_SIZE).then( async txs => {
          console.log(`Getting ${txs.length} transactions from index ${i}`);
          
          let txHashes: Record<number, string> = {};
          let indexedTxs: IndexedTx[] = [];

          let txHashesPending: Record<number, string> = {};
          let indexedTxsPending: IndexedTx[] = [];

          let maxMinedIndex = -1;
          let maxPendingIndex = -1;

          for (let txIdx = 0; txIdx < txs.length; ++txIdx) {
            const tx = txs[txIdx];
            // Get the first leaf index in the tree
            const memo_idx = i + txIdx * OUTPLUSONE;
            
            // tx structure from relayer: mined flag + txHash(32 bytes, 64 chars) + commitment(32 bytes, 64 chars) + memo
            // 1. Extract memo block
            const memo = tx.slice(129); // Skip mined flag, txHash and commitment

            // 2. Get transaction commitment
            const commitment = tx.substr(65, 64)
            
            const indexedTx: IndexedTx = {
              index: memo_idx,
              memo: memo,
              commitment: commitment,
            }

            // 3. Get txHash
            const txHash = tx.substr(1, 64);

            // 4. Get mined flag
            if (tx.substr(0, 1) === '1') {
              indexedTxs.push(indexedTx);
              txHashes[memo_idx] = '0x' + txHash;
              maxMinedIndex = Math.max(maxMinedIndex, memo_idx);
            } else {
              indexedTxsPending.push(indexedTx);
              txHashesPending[memo_idx] = '0x' + txHash;
              maxPendingIndex = Math.max(maxPendingIndex, memo_idx);
            }
          }

          if (indexedTxs.length > 0) {
            const parseResult = await this.worker.parseTxs(this.config.sk, indexedTxs);
            const decryptedMemos = parseResult.decryptedMemos;
            state.account.updateState(parseResult.stateUpdate);
            this.logStateSync(i, i + txs.length * OUTPLUSONE, decryptedMemos);
            for (let decryptedMemoIndex = 0; decryptedMemoIndex < decryptedMemos.length; ++decryptedMemoIndex) {
              // save memos corresponding to the our account to restore history
              const myMemo = decryptedMemos[decryptedMemoIndex];
              myMemo.txHash = txHashes[myMemo.index];
              zpState.history.saveDecryptedMemo(myMemo, false);
            }
          }

          if (indexedTxsPending.length > 0) {
            const parseResult = await this.worker.parseTxs(this.config.sk, indexedTxsPending);
            const decryptedPendingMemos = parseResult.decryptedMemos;
            for (let idx = 0; idx < decryptedPendingMemos.length; ++idx) {
              // save memos corresponding to the our account to restore history
              const myMemo = decryptedPendingMemos[idx];
              myMemo.txHash = txHashesPending[myMemo.index];
              zpState.history.saveDecryptedMemo(myMemo, true);

              if (myMemo.acc != undefined) {
                // There is a pending transaction initiated by ourselfs
                // So we cannot create new transactions in that case
                readyToTransact = false;
              }
            }
          }

          return {txCount: txs.length, maxMinedIndex, maxPendingIndex} ;
        });
        batches.push(oneBatch);
      };

      let initRes: BatchResult = {txCount: 0, maxMinedIndex: -1, maxPendingIndex: -1}
      let totalRes = (await Promise.all(batches)).reduce((acc, cur) => {
        return {
          txCount: acc.txCount + cur.txCount,
          maxMinedIndex: Math.max(acc.maxMinedIndex, cur.maxMinedIndex),
          maxPendingIndex: Math.max(acc.maxPendingIndex, cur.maxPendingIndex),
        }
      }, initRes);

      // remove unneeded pending records
      zpState.history.setLastMinedTxIndex(totalRes.maxMinedIndex);
      zpState.history.setLastPendingTxIndex(totalRes.maxPendingIndex);


      const msElapsed = Date.now() - startTime;
      const avgSpeed = msElapsed / totalRes.txCount

      console.log(`Sync finished in ${msElapsed / 1000} sec | ${totalRes.txCount} tx, avg speed ${avgSpeed.toFixed(1)} ms/tx`);

      return readyToTransact;
    } else {
      console.log(`Local state is up to date @${startIndex}`);

      return true;
    }
  }

  public async logStateSync(startIndex: number, endIndex: number, decryptedMemos: DecryptedMemo[]) {
    const OUTPLUSONE = CONSTANTS.OUT + 1;
    for (let decryptedMemo of decryptedMemos) {
      if (decryptedMemo.index > startIndex) {
        console.info(`📝 Adding hashes to state (from index ${startIndex} to index ${decryptedMemo.index - OUTPLUSONE})`);
      }
      startIndex = decryptedMemo.index + OUTPLUSONE; 

      if (decryptedMemo.acc) {
        console.info(`📝 Adding account, notes, and hashes to state (at index ${decryptedMemo.index})`);
      } else {
        console.info(`📝 Adding notes and hashes to state (at index ${decryptedMemo.index})`);
      }
    }

    if (startIndex < endIndex) {
      console.info(`📝 Adding hashes to state (from index ${startIndex} to index ${endIndex - OUTPLUSONE})`);
    }
  }
}
