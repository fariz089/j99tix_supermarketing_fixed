class JobGenerator {
    static generateTasks(jobId, type, config, deviceIds) {
        switch (type) {
            case 'super_marketing':
                return this.generateSuperMarketingTasks(jobId, config, deviceIds);
            case 'warmup':
                return this.generateWarmupTasks(jobId, config, deviceIds);
            case 'boost_live':
                return this.generateBoostLiveTasks(jobId, config, deviceIds);
            case 'masscomment':
                return this.generateMassCommentTasks(jobId, config, deviceIds);
            case 'profile_boost':
                return this.generateProfileBoostTasks(jobId, config, deviceIds);
            default:
                throw new Error(`Unknown job type: ${type}`);
        }
    }

    /**
     * UPDATED: Super Marketing sekarang berbasis CYCLE
     * 
     * Sebelum: 1000 target = 1000 task (masing-masing device ambil task round-robin)
     * Sesudah: 1000 cycles = 1 task per device, setiap device loop 1000x
     * 
     * Dengan 80 device dan 1000 cycles:
     * - Setiap device menjalankan 1000 cycles
     * - Total views = 80 device × 1000 cycles = 80,000 views
     * - 1 cycle selesai = semua device selesai 1 round
     */
    static generateSuperMarketingTasks(jobId, config, deviceIds) {
        const tasks = [];
        const targetCycles = config.numWatching || 100; // numWatching sekarang = jumlah cycles

        // BARU: 1 task per device, dengan totalCycles di config
        deviceIds.forEach((deviceId, index) => {
            tasks.push({
                id: `${jobId}_task_${index}`,
                jobId,
                type: 'super_marketing',
                config: {
                    ...config,
                    totalCycles: targetCycles, // Pass total cycles ke task
                    jobId: jobId
                },
                assignedDevice: deviceId
            });
        });

        const totalViews = deviceIds.length * targetCycles * (config.urls?.length || 1);
        console.log(`✅ Generated ${tasks.length} super marketing tasks`);
        console.log(`   📊 ${deviceIds.length} devices × ${targetCycles} cycles × ${config.urls?.length || 1} URLs = ${totalViews} total views`);
        
        return tasks;
    }

    static generateWarmupTasks(jobId, config, deviceIds) {
        const tasks = [];

        deviceIds.forEach(deviceId => {
            tasks.push({
                id: `${jobId}_task_${deviceId}`,
                jobId,
                type: 'warmup',
                config: config,
                assignedDevice: deviceId
            });
        });

        console.log(`✅ Generated ${tasks.length} warmup tasks`);
        return tasks;
    }

    static generateBoostLiveTasks(jobId, config, deviceIds) {
        const tasks = [];

        deviceIds.forEach((deviceId, index) => {
            tasks.push({
                id: `${jobId}_task_${deviceId}`,
                jobId,
                type: 'boost_live',
                config: {
                    ...config,
                    jobId,
                    deviceIndex: index  // Pass device index for sequential staggering
                },
                assignedDevice: deviceId
            });
        });

        const joinDelay = config.joinDelay || 0;
        const totalSpread = (deviceIds.length - 1) * joinDelay;
        console.log(`✅ Generated ${tasks.length} boost live tasks`);
        if (joinDelay > 0) {
            console.log(`   ⏱️ Sequential join: ${joinDelay}s between devices (total spread: ${totalSpread}s)`);
        }
        console.log(`   ❤️ Like: ${config.likeEnabled !== false ? 'ON' : 'OFF'} (delay: ${config.likeDelay || 0}s)`);
        console.log(`   💬 Comment: ${config.commentEnabled !== false ? 'ON' : 'OFF'} (delay: ${config.commentDelay || 0}s)`);
        console.log(`   🔄 Share: ${config.shareEnabled !== false ? 'ON' : 'OFF'} (delay: ${config.shareDelay || 0}s)`);
        return tasks;
    }

    /**
     * Profile Boost: 1 task per device, each device loops totalCycles times.
     * Per cycle: open profile (search or deep link) → tap video at startIndex →
     * watch → swipe up to next → repeat until stopIndex.
     */
    static generateProfileBoostTasks(jobId, config, deviceIds) {
        const tasks = [];
        const targetCycles = config.totalCycles || 1;

        deviceIds.forEach((deviceId, index) => {
            tasks.push({
                id: `${jobId}_task_${index}`,
                jobId,
                type: 'profile_boost',
                config: {
                    ...config,
                    totalCycles: targetCycles,
                    jobId
                },
                assignedDevice: deviceId
            });
        });

        const scrollCount = config.scrollCount || 0;
        const videosPerCycle = 1 + scrollCount;
        const totalViews = deviceIds.length * targetCycles * videosPerCycle;
        console.log(`✅ Generated ${tasks.length} profile boost tasks`);
        console.log(`   📊 ${deviceIds.length} devices × ${targetCycles} cycles × ${videosPerCycle} videos (1+${scrollCount} swipes) = ${totalViews} total views`);
        console.log(`   👤 Target: @${config.username}`);
        return tasks;
    }

    static generateMassCommentTasks(jobId, config, deviceIds) {
        const tasks = [];
        const {
            url,
            comments = [],
            commentsPerDevice = 1,
            idleDelayMin = 2,
            idleDelayMax = 5,
            scrollCount = 5,
            scrollDelayMin = 2,
            scrollDelayMax = 5,
            deviceStartDelay = 0
        } = config;

        let taskCounter = 0;

        deviceIds.forEach((deviceId, deviceIndex) => {
            for (let i = 0; i < commentsPerDevice; i++) {
                const comment = comments[taskCounter % comments.length];
                
                // Calculate staggered delay for this device
                // Device 0 = 0s, Device 1 = deviceStartDelay, Device 2 = deviceStartDelay * 2, etc.
                const staggerDelay = deviceIndex * deviceStartDelay;

                tasks.push({
                    id: `${jobId}_task_${taskCounter}`,
                    jobId,
                    type: 'masscomment',
                    config: {
                        url,
                        comment,
                        idleDelayMin,
                        idleDelayMax,
                        scrollCount,
                        scrollDelayMin,
                        scrollDelayMax,
                        deviceStartDelay: staggerDelay,
                        deviceIndex: deviceIndex,
                        jobId
                    },
                    assignedDevice: deviceId
                });

                taskCounter++;
            }
        });

        console.log(`✅ Generated ${tasks.length} mass comment tasks (${deviceIds.length} devices, ${commentsPerDevice} comments each)`);
        if (deviceStartDelay > 0) {
            console.log(`   ⏱️ Device stagger: ${deviceStartDelay}s between each device (total spread: ${(deviceIds.length - 1) * deviceStartDelay}s)`);
        }
        return tasks;
    }
}

module.exports = JobGenerator;
