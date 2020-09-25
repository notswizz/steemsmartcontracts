/* eslint-disable no-await-in-loop */
/* global actions, api */

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('miningPower');
  if (tableExists === false) {
    await api.db.createTable('miningPower', ['id', 'power']);
    await api.db.createTable('pools', ['id']);
    // Given symbol, output which pools are using it.
    await api.db.createTable('tokenPools', ['symbol']);
    await api.db.createTable('params');

    const params = {};
    params.poolCreationFee = '1000';
    params.poolUpdateFee = '300';
    await api.db.insert('params', params);
  }
};

actions.updateParams = async (payload) => {
  if (api.sender !== api.owner) return;

  const { poolCreationFee, poolUpdateFee } = payload;

  const params = await api.db.findOne('params', {});

  params.poolCreationFee = poolCreationFee;
  params.poolUpdateFee = poolUpdateFee;
  await api.db.update('params', params);
};

const findAndProcessAll = async (contractName, table, query, callback) => {
  let offset = 0;
  let results = [];
  let done = false;
  while (!done) {
    results = await api.db.findInTable(contractName, table, query, 1000, offset);
    if (results) {
      for (let i = 0; i < results.length; i += 1) {
        await callback(results[i]);
      }
      if (results.length < 1000) {
        done = true;
      } else {
        offset += 1000;
      }
    }
  }
};

async function validateTokenMiners(tokenMiners) {
  if (!api.assert(tokenMiners && Array.isArray(tokenMiners), 'tokenMiners invalid')) return false;
  if (!api.assert(tokenMiners.length >= 1 && tokenMiners.length <= 2,
    'only 1 or 2 tokenMiners allowed')) return false;
  const tokenMinerSymbols = new Set();
  for (let i = 0; i < tokenMiners.length; i += 1) {
    const tokenMinerConfig = tokenMiners[i];
    if (!api.assert(tokenMinerConfig && tokenMinerConfig.symbol
      && typeof (tokenMinerConfig.symbol) === 'string', 'tokenMiners invalid')) return false;
    if (!api.assert(!tokenMinerSymbols.has(tokenMinerConfig.symbol), 'tokenMiners cannot have duplicate symbols')) return false;
    tokenMinerSymbols.add(tokenMinerConfig.symbol);
    const { symbol } = tokenMinerConfig;
    const token = await api.db.findOneInTable('tokens', 'tokens', { symbol });
    if (!api.assert(token && token.stakingEnabled, 'tokenMiners must have staking enabled')) return false;
    if (!api.assert(Number.isInteger(tokenMinerConfig.multiplier)
      && tokenMinerConfig.multiplier >= 1 && tokenMinerConfig.multiplier <= 100,
    'tokenMiner multiplier must be an integer from 1 to 100')) return false;
  }
  return true;
}

function validateTokenMinersChange(oldTokenMiners, tokenMiners) {
  if (!api.assert(tokenMiners.length === oldTokenMiners.length, 'cannot change which tokens are in tokenMiners')) return false;
  let changed = false;
  for (let i = 0; i < tokenMiners.length; i += 1) {
    const oldConfig = oldTokenMiners[i];
    const newConfig = tokenMiners[i];
    if (!api.assert(oldConfig.symbol === newConfig.symbol, 'cannot change which tokens are in tokenMiners')) return false;
    if (!api.assert(Number.isInteger(newConfig.multiplier) && newConfig.multiplier >= 1 && newConfig.multiplier <= 100, 'tokenMiner multiplier must be an integer from 1 to 100')) return false;
    if (oldConfig.multiplier !== newConfig.multiplier) {
      changed = true;
    }
  }
  return { changed };
}

function computeMiningPower(miningPower, tokenMiners) {
  let power = api.BigNumber(0);
  for (let i = 0; i < tokenMiners.length; i += 1) {
    if (miningPower.balances[i]) {
      power = power.plus(api.BigNumber(miningPower.balances[i])
        .multipliedBy(tokenMiners[i].multiplier));
    }
  }
  return power;
}

async function updateMiningPower(pool, token, account, stakedQuantity, delegatedQuantity, reset) {
  let miningPower = await api.db.findOne('miningPower', { id: pool.id, account });
  let stake = api.BigNumber(stakedQuantity);
  let oldMiningPower = api.BigNumber(0);
  stake = stake.plus(delegatedQuantity);
  const tokenIndex = pool.tokenMiners.findIndex(t => t.symbol === token);
  if (!miningPower) {
    const balances = {};
    balances[tokenIndex] = stake;
    miningPower = {
      id: pool.id,
      account,
      balances,
      power: { $numberDecimal: '0' },
    };
    miningPower = await api.db.insert('miningPower', miningPower);
  } else {
    if (!miningPower.balances[tokenIndex] || reset) {
      miningPower.balances[tokenIndex] = '0';
    }
    miningPower.balances[tokenIndex] = stake.plus(miningPower.balances[tokenIndex]);
    oldMiningPower = miningPower.power.$numberDecimal;
  }
  const newMiningPower = computeMiningPower(miningPower, pool.tokenMiners);
  miningPower.power = { $numberDecimal: newMiningPower };
  await api.db.update('miningPower', miningPower);
  return newMiningPower.minus(oldMiningPower);
}

async function initMiningPower(pool, token, reset) {
  let totalAdjusted = api.BigNumber(0);
  await findAndProcessAll('tokens', 'balances', { symbol: token }, async (balance) => {
    const adjusted = await updateMiningPower(
      pool, token, balance.account, balance.stake, balance.delegationsIn, reset,
    );
    totalAdjusted = totalAdjusted.plus(adjusted);
  });
  return totalAdjusted;
}

actions.updatePool = async (payload) => {
  const {
    id, lotteryWinners, lotteryIntervalHours, lotteryAmount, tokenMiners, active,
    isSignedWithActiveKey,
  } = payload;

  // get contract params
  const params = await api.db.findOne('params', {});
  const { poolUpdateFee } = params;
  // get api.sender's UTILITY_TOKEN_SYMBOL balance
  // eslint-disable-next-line no-template-curly-in-string
  const utilityTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });

  const authorized = api.BigNumber(poolUpdateFee).lte(0)
    ? true
    : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(poolUpdateFee);

  if (api.assert(authorized, 'you must have enough tokens to cover the update fee')
    && api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(id && typeof id === 'string'
      && lotteryAmount && typeof lotteryAmount === 'string' && !api.BigNumber(lotteryAmount).isNaN() && api.BigNumber(lotteryAmount).gt(0), 'invalid params')) {
    if (api.assert(Number.isInteger(lotteryWinners) && lotteryWinners >= 1 && lotteryWinners <= 20, 'invalid lotteryWinners: integer between 1 and 20 only')
      && api.assert(Number.isInteger(lotteryIntervalHours) && lotteryIntervalHours >= 1 && lotteryIntervalHours <= 720, 'invalid lotteryIntervalHours: integer between 1 and 720 only')) {
      const pool = await api.db.findOne('pools', { id });
      if (api.assert(pool, 'pool id not found')) {
        const minedTokenObject = await api.db.findOneInTable('tokens', 'tokens', { symbol: pool.minedToken });
        if (api.assert(minedTokenObject && minedTokenObject.issuer === api.sender, 'must be issuer of minedToken')
          && api.assert(api.BigNumber(lotteryAmount).dp() <= minedTokenObject.precision, 'minedToken precision mismatch for lotteryAmount')) {
          const validMinersChange = validateTokenMinersChange(pool.tokenMiners, tokenMiners);
          if (validMinersChange) {
            pool.lotteryWinners = lotteryWinners;
            pool.lotteryIntervalHours = lotteryIntervalHours;
            pool.lotteryAmount = lotteryAmount;
            pool.tokenMiners = tokenMiners;
            pool.active = active;

            if (validMinersChange.changed) {
              for (let i = 0; i < tokenMiners.length; i += 1) {
                const tokenConfig = tokenMiners[i];
                await api.db.insert('tokenPools', { symbol: tokenConfig.symbol, id: pool.id });
                const adjustedPower = await initMiningPower(pool, tokenConfig.symbol, true);
                pool.totalPower = api.BigNumber(pool.totalPower).plus(adjustedPower);
              }
            }

            const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
            pool.nextLotteryTimestamp = api.BigNumber(blockDate.getTime())
              .plus(lotteryIntervalHours * 3600 * 1000).toNumber();

            await api.db.update('pools', pool);

            // burn the token creation fees
            if (api.BigNumber(poolUpdateFee).gt(0)) {
              await api.executeSmartContract('tokens', 'transfer', {
                // eslint-disable-next-line no-template-curly-in-string
                to: 'null', symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'", quantity: poolUpdateFee, isSignedWithActiveKey,
              });
            }
          }
        }
      }
    }
  }
};

function generatePoolId(pool) {
  const tokenMinerString = pool.tokenMiners.map(t => t.symbol.replace('.', '-')).sort().join(',');
  return `${pool.minedToken.replace('.', '-')}:${tokenMinerString}`;
}

actions.createPool = async (payload) => {
  const {
    lotteryWinners, lotteryIntervalHours, lotteryAmount, minedToken, tokenMiners,
    isSignedWithActiveKey,
  } = payload;

  // get contract params
  const params = await api.db.findOne('params', {});
  const { poolCreationFee } = params;

  // get api.sender's UTILITY_TOKEN_SYMBOL balance
  // eslint-disable-next-line no-template-curly-in-string
  const utilityTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });

  const authorizedCreation = api.BigNumber(poolCreationFee).lte(0)
    ? true
    : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(poolCreationFee);

  if (api.assert(authorizedCreation, 'you must have enough tokens to cover the creation fee')
      && api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
      && api.assert(minedToken && typeof minedToken === 'string'
        && lotteryAmount && typeof lotteryAmount === 'string' && !api.BigNumber(lotteryAmount).isNaN() && api.BigNumber(lotteryAmount).gt(0), 'invalid params')) {
    if (api.assert(minedToken.length > 0 && minedToken.length <= 10, 'invalid symbol: uppercase letters only, max length of 10')
      && api.assert(Number.isInteger(lotteryWinners) && lotteryWinners >= 1 && lotteryWinners <= 20, 'invalid lotteryWinners: integer between 1 and 20 only')
      && api.assert(Number.isInteger(lotteryIntervalHours) && lotteryIntervalHours >= 1 && lotteryIntervalHours <= 720, 'invalid lotteryIntervalHours: integer between 1 and 720 only')
    ) {
      const minedTokenObject = await api.db.findOneInTable('tokens', 'tokens', { symbol: minedToken });

      if (api.assert(minedTokenObject, 'minedToken does not exist')
        && api.assert(minedTokenObject.issuer === api.sender, 'must be issuer of minedToken')
        && api.assert(api.BigNumber(lotteryAmount).dp() <= minedTokenObject.precision, 'minedToken precision mismatch for lotteryAmount')
        && await validateTokenMiners(tokenMiners)) {
        const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
        const newPool = {
          minedToken,
          lotteryWinners,
          lotteryIntervalHours,
          lotteryAmount,
          tokenMiners,
          active: true,
          nextLotteryTimestamp: api.BigNumber(blockDate.getTime())
            .plus(lotteryIntervalHours * 3600 * 1000).toNumber(),
          totalPower: '0',
        };
        newPool.id = generatePoolId(newPool);

        const existingPool = await api.db.findOne('pools', { id: newPool.id });
        if (api.assert(!existingPool, 'pool already exists')) {
          for (let i = 0; i < tokenMiners.length; i += 1) {
            const tokenConfig = tokenMiners[i];
            await api.db.insert('tokenPools', { symbol: tokenConfig.symbol, id: newPool.id });
            const adjustedPower = await initMiningPower(newPool, tokenConfig.symbol);
            newPool.totalPower = api.BigNumber(newPool.totalPower)
              .plus(adjustedPower);
          }
          await api.db.insert('pools', newPool);

          // burn the token creation fees
          if (api.BigNumber(poolCreationFee).gt(0)) {
            await api.executeSmartContract('tokens', 'transfer', {
              // eslint-disable-next-line no-template-curly-in-string
              to: 'null', symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'", quantity: poolCreationFee, isSignedWithActiveKey,
            });
          }
        }
      }
    }
  }
};

actions.checkPendingLotteries = async () => {
  if (api.assert(api.sender === 'null', 'not authorized')) {
    const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
    const timestamp = blockDate.getTime();

    await findAndProcessAll('mining', 'pools',
      {
        active: true,
        nextLotteryTimestamp: {
          $lte: timestamp,
        },
      },
      async (pool) => {
        const winningNumbers = [];
        const minedToken = await api.db.findOneInTable('tokens', 'tokens',
          { symbol: pool.minedToken });
        const winningAmount = api.BigNumber(pool.lotteryAmount).dividedBy(pool.lotteryWinners)
          .toFixed(minedToken.precision);
        for (let i = 0; i < pool.lotteryWinners; i += 1) {
          winningNumbers[i] = api.BigNumber(pool.totalPower).multipliedBy(api.random());
        }
        // iterate power desc
        let offset = 0;
        let miningPowers;
        let cumulativePower = api.BigNumber(0);
        let nextCumulativePower = api.BigNumber(0);
        let computedWinners = 0;
        const winners = [];
        while (computedWinners < pool.lotteryWinners) {
          miningPowers = await api.db.find('miningPower', { id: pool.id, power: { $gt: { $numberDecimal: '0' } } }, 1000, offset, [{ index: 'power', descending: true }]);
          for (let i = 0; i < miningPowers.length; i += 1) {
            const miningPower = miningPowers[i];
            nextCumulativePower = cumulativePower.plus(miningPower.power.$numberDecimal);
            for (let j = 0; j < pool.lotteryWinners; j += 1) {
              const currentWinningNumber = winningNumbers[j];
              if (cumulativePower.lte(currentWinningNumber)
                  && nextCumulativePower.gt(currentWinningNumber)) {
                computedWinners += 1;
                winners.push({
                  winner: miningPower.account,
                  winningNumber: currentWinningNumber,
                  winningAmount,
                });
                await api.executeSmartContract('tokens', 'issue',
                  { to: miningPower.account, symbol: minedToken.symbol, quantity: winningAmount });
              }
            }
            cumulativePower = nextCumulativePower;
          }
          if (computedWinners === pool.lotteryWinners || miningPowers.length < 1000) {
            break;
          }
          offset += 1000;
        }
        api.emit('miningLottery', { poolId: pool.id, winners });
        // eslint-disable-next-line no-param-reassign
        pool.nextLotteryTimestamp = api.BigNumber(blockDate.getTime())
          .plus(pool.lotteryIntervalHours * 3600 * 1000).toNumber();
        await api.db.update('pools', pool);
      });
  }
};

actions.handleStakeChange = async (payload) => {
  const {
    account, symbol, quantity, delegated, callingContractInfo,
  } = payload;
  if (api.assert(callingContractInfo.name === 'tokens'
      && api.sender === api.owner, 'must be called from tokens contract')) {
    await findAndProcessAll('mining', 'tokenPools', { symbol }, async (tokenPool) => {
      const pool = await api.db.findOne('pools', { id: tokenPool.id });
      let adjusted;
      if (delegated) {
        adjusted = await updateMiningPower(pool, symbol, account, 0, quantity);
      } else {
        adjusted = await updateMiningPower(pool, symbol, account, quantity, 0);
      }
      pool.totalPower = adjusted.plus(pool.totalPower);
      await api.db.update('pools', pool);
    });
  }
};
