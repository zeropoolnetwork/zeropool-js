import { AbiItem } from 'web3-utils';
import { Contract } from 'web3-eth-contract';
import { assembleAddress, Note, validateAddress, Output, Proof } from 'libzeropool-rs-wasm-web';

import { SnarkParams, Tokens } from './config';
import { hexToBuf, toCompactSignature } from './utils';
import { ZeroPoolState } from './state';
import { parseHashes, TxType } from './tx';

export interface RelayerInfo {
  root: string;
  deltaIndex: string;
}

async function fetchTransactions(relayerUrl: string, offset: BigInt, limit: number = 100): Promise<string[]> {
  const url = new URL('/transactions', relayerUrl);
  url.searchParams.set('offset', offset.toString());
  url.searchParams.set('limit', limit.toString());

  const res = await (await fetch(url.toString())).json();

  return res;
}

async function sendTransaction(relayerUrl: string, proof: Proof, memo: string, txType: TxType, depositSignature?: string): Promise<string> {
  const url = new URL('/transaction', relayerUrl);
  const res = await fetch(url.toString(), { method: 'POST', body: JSON.stringify({ proof, memo, txType, depositSignature }) });

  if (!res.ok) {
    const body = await res.json();
    throw new Error(`Error ${res.status}: ${JSON.stringify(body)}`)
  }

  const json = await res.json();

  const INTERVAL_MS = 1000;
  let hash;
  while (true) {
    const job = await getJob(relayerUrl, json.jobId);

    if (job === null) {
      console.error(`Job ${json.jobId} not found.`);
      throw new Error('Job not found');
    } else if (job.state === 'failed') {
      throw new Error('Transaction failed');
    } else if (job.state = 'completed') {
      hash = job.txHash;
      break;
    }

    await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
  }

  // if (!hash) {
  //     throw new Error('Transaction failed');
  // }

  console.info(`Transaction successful: ${hash}`);

  return hash;
}

async function getJob(relayerUrl: string, id: string): Promise<{ state: string, txHash: string } | null> {
  const url = new URL(`/job/${id}`, relayerUrl);
  const res = await (await fetch(url.toString())).json();

  if (typeof res === 'string') {
    return null;
  } else {
    return res;
  }
}

async function info(relayerUrl: string): Promise<RelayerInfo> {
  const url = new URL('/info', relayerUrl);
  const res = await fetch(url.toString());

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
  networkName: string;
  /** Should the signature be compact (for EVM based blockchains)  */
  compactSignature: boolean;
}

export class ZeropoolClient {
  private zpStates: { [tokenAddress: string]: ZeroPoolState };
  private worker: any;
  private snarkParams: SnarkParams;
  private tokens: Tokens;
  private config: ClientConfig;

  public static async create(config: ClientConfig): Promise<ZeropoolClient> {
    const client = new ZeropoolClient();
    client.zpStates = {};
    client.worker = config.worker;
    client.snarkParams = config.snarkParams;
    client.tokens = config.tokens;
    client.config = config;

    const abi: AbiItem[] = [
      {
        constant: true,
        inputs: [],
        name: 'denominator',
        outputs: [
          {
            name: '',
            type: 'uint256',
          }
        ],
        payable: false,
        type: 'function',
      }
    ];

    for (const [address, _token] of Object.entries(config.tokens)) {
      const contract = new Contract(abi, address);
      const denominator = await contract.methods.denominator().call();
      client.zpStates[address] = await ZeroPoolState.create(config.sk, config.networkName, denominator);
    }

    return client;
  }

  // TODO: generalize wei/gwei
  public async deposit(tokenAddress: string, amountWei: string, sign: (data: string) => Promise<string>, fromAddress: string | null = null, fee: string = '0'): Promise<void> {
    await this.updateState(tokenAddress);

    const token = this.tokens[tokenAddress];
    const state = this.zpStates[tokenAddress];

    const txType = TxType.Deposit;
    const amountGwei = (BigInt(amountWei) / state.denominator).toString();
    const txData = await state.account.createDeposit({ amount: amountGwei, fee });
    const txProof = await this.worker.proveTx(txData.public, txData.secret);
    const txValid = Proof.verify(this.snarkParams.transferVk!, txProof.inputs, txProof.proof);
    if (!txValid) {
      throw new Error('invalid tx proof');
    }

    const nullifier = '0x' + BigInt(txData.public.nullifier).toString(16).padStart(64, '0');

    // TODO: Sign fromAddress as well?
    const signature = await sign(nullifier);
    let fullSignature = signature;
    if (fromAddress) {
      fullSignature = fromAddress + signature;
    }

    if (this.config.compactSignature) {
      fullSignature = toCompactSignature(fullSignature);
    }

    await sendTransaction(token.relayerUrl, txProof, txData.memo, txType, fullSignature);
  }

  public async transfer(tokenAddress: string, outsWei: Output[], fee: string = '0'): Promise<void> {
    await this.updateState(tokenAddress);

    const token = this.tokens[tokenAddress];
    const state = this.zpStates[tokenAddress];

    const txType = TxType.Transfer;
    const outGwei = outsWei.map(({ to, amount }) => {
      if (!validateAddress(to)) {
        throw new Error('Invalid address. Expected a shielded address.');
      }

      return {
        to,
        amount: (BigInt(amount) / state.denominator).toString(),
      }
    });

    const txData = await state.account.createTransfer({ outputs: outGwei, fee });
    const txProof = await this.worker.proveTx(txData.public, txData.secret);
    const txValid = Proof.verify(this.snarkParams.transferVk!, txProof.inputs, txProof.proof);
    if (!txValid) {
      throw new Error('invalid tx proof');
    }

    await sendTransaction(token.relayerUrl, txProof, txData.memo, txType);
  }

  public async withdraw(tokenAddress: string, address: string, amountWei: string, fee: string = '0'): Promise<void> {
    await this.updateState(tokenAddress);

    const token = this.tokens[tokenAddress];
    const state = this.zpStates[tokenAddress];

    const txType = TxType.Withdraw;
    const addressBin = hexToBuf(address);

    const amountGwei = (BigInt(amountWei) / state.denominator).toString();
    const txData = await state.account.createWithdraw({ amount: amountGwei, to: addressBin, fee, native_amount: '0', energy_amount: '0' });
    const txProof = await this.worker.proveTx(txData.public, txData.secret);
    const txValid = Proof.verify(this.snarkParams.transferVk!, txProof.inputs, txProof.proof);
    if (!txValid) {
      throw new Error('invalid tx proof');
    }

    await sendTransaction(token.relayerUrl, txProof, txData.memo, txType);
  }

  // TODO: Transaction list


  public async getTotalBalance(tokenAddress: string): Promise<string> {
    await this.updateState(tokenAddress);

    return this.zpStates[tokenAddress].getTotalBalance();
  }

  /**
   * @returns [total, account, note]
   */
  public async getBalances(tokenAddress: string): Promise<[string, string, string]> {
    await this.updateState(tokenAddress);

    return this.zpStates[tokenAddress].getBalances();
  }

  public async updateState(tokenAddress: string): Promise<void> {
    const OUT = 128;

    const token = this.tokens[tokenAddress];

    let totalNumTx = 100;
    for (let i = 0; i < totalNumTx; i += OUT) { // FIXME: step
      const data = await fetchTransactions(token.relayerUrl, BigInt(i), 100);

      for (let tx of data) {
        let hashes = parseHashes(tx);
        this.cacheShieldedTx(tokenAddress, tx, hashes, i);
      }
    }
  }

  // TODO: Make updateState implementation configurable through DI.

  // public async updateStateFromNode(tokenAddress: string) {
  //   const STORAGE_PREFIX = `${STATE_STORAGE_PREFIX}.latestCheckedBlock`;

  //   // TODO: Fetch txs from relayer
  //   // await this.fetchTransactionsFromRelayer(tokenAddress);

  //   const token = this.tokens[tokenAddress];
  //   const state = this.zpStates[tokenAddress];
  //   const curBlockNumber = await this.web3.eth.getBlockNumber();
  //   const latestCheckedBlock = Number(localStorage.getItem(STORAGE_PREFIX)) || 0;

  //   // moslty useful for local testing, since getPastLogs always returns at least one latest event
  //   if (curBlockNumber === latestCheckedBlock) {
  //     return;
  //   }

  //   console.info(`Processing contract events since block ${latestCheckedBlock} to ${curBlockNumber}`);

  //   const logs = await this.web3.eth.getPastLogs({
  //     fromBlock: latestCheckedBlock,
  //     toBlock: curBlockNumber,
  //     address: token.poolAddress,
  //     topics: [
  //       keccak256(MESSAGE_EVENT_SIGNATURE)
  //     ]
  //   });

  //   const STEP: number = (CONSTANTS.OUT + 1);
  //   let index = Number(state.account.nextTreeIndex());
  //   for (const log of logs) {
  //     // TODO: Batch getTransaction
  //     const tx = await this.web3.eth.getTransaction(log.transactionHash);
  //     const message = tx.input;
  //     const txData = EvmShieldedTx.decode(message);

  //     let hashes;
  //     try {
  //       hashes = txData.hashes;
  //     } catch (err) {
  //       console.info(`❌ Skipping invalid transaction: invalid number of outputs ${err.numOutputs}`);
  //       continue;
  //     }

  //     let res = this.cacheShieldedTx(tokenAddress, txData.ciphertext, hashes, index);
  //     if (res) {
  //       index += STEP;
  //     }
  //   }

  //   localStorage.setItem(STORAGE_PREFIX, curBlockNumber.toString());
  // }

  /**
   * Attempt to extract and save usable account/notes from transaction data.
   * @param raw hex-encoded transaction data
   */
  private cacheShieldedTx(tokenAddress: string, ciphertext: string, hashes: string[], index: number): boolean {
    const state = this.zpStates[tokenAddress];

    const data = hexToBuf(ciphertext);
    const pair = state.account.decryptPair(data);
    const onlyNotes = state.account.decryptNotes(data);

    // Can't rely on txData.transferIndex here since it can be anything as long as index <= pool index
    if (pair) {
      const notes = pair.notes.reduce<{ note: Note, index: number }[]>((acc, note, noteIndex) => {
        const address = assembleAddress(note.d, note.p_d);
        if (state.account.isOwnAddress(address)) {
          acc.push({ note, index: index + 1 + noteIndex });
        }
        return acc;
      }, []);

      console.info(`📝 Adding account, notes, and hashes to state (at index ${index})`);
      state.account.addAccount(BigInt(index), hashes, pair.account, notes);
    } else if (onlyNotes.length > 0) {
      console.info(`📝 Adding notes and hashes to state (at index ${index})`);
      state.account.addNotes(BigInt(index), hashes, onlyNotes);
    } else {
      console.info(`📝 Adding hashes to state (at index ${index})`);
      state.account.addHashes(BigInt(index), hashes);
    }

    console.debug('New balance:', state.account.totalBalance());
    console.debug('New state:', state.account.getWholeState());

    return true;
  }

  public free(): void {
    for (let state of Object.values(this.zpStates)) {
      state.free();
    }
  }
}