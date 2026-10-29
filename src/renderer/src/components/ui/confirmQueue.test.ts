import { describe, expect, it, vi } from 'vitest'
import { createConfirmQueue, createDialogScope, withActionLock } from './confirmQueue'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('confirmation queue', () => {
  it('shows one request at a time in FIFO order without losing the first resolver', async () => {
    const queue = createConfirmQueue()
    const first = queue.confirm({ title: 'first' })
    const second = queue.prompt({ title: 'second', defaultValue: 'original' })
    const third = queue.confirm({ title: 'third' })

    expect(queue.getSnapshot()?.title).toBe('first')
    queue.accept(queue.getSnapshot()!.id)
    await expect(first).resolves.toBe(true)
    expect(queue.getSnapshot()).toMatchObject({ kind: 'prompt', title: 'second', defaultValue: 'original' })
    queue.accept(queue.getSnapshot()!.id, ' edited ')
    await expect(second).resolves.toBe('edited')
    expect(queue.getSnapshot()?.title).toBe('third')
    queue.cancel(queue.getSnapshot()!.id)
    await expect(third).resolves.toBe(false)
    expect(queue.getSnapshot()).toBeNull()
  })

  it('ignores a repeated click from a settled dialog instead of accepting the next request', async () => {
    const queue = createConfirmQueue()
    const first = queue.confirm({ title: 'same title' })
    const firstId = queue.getSnapshot()!.id
    const second = queue.confirm({ title: 'same title' })
    expect(queue.accept(firstId)).toBe(true)
    expect(queue.accept(firstId)).toBe(false)
    expect(queue.cancel(firstId)).toBe(false)
    await expect(first).resolves.toBe(true)
    expect(queue.getSnapshot()?.id).not.toBe(firstId)
    queue.cancel(queue.getSnapshot()!.id)
    await expect(second).resolves.toBe(false)
  })

  it('rejects duplicate operation keys with a separate false promise and releases the key after settlement', async () => {
    const queue = createConfirmQueue()
    const first = queue.confirm({ title: 'delete', operationKey: 'note:1:delete' })
    const duplicate = queue.confirm({ title: 'delete', operationKey: 'note:1:delete' })
    expect(duplicate).not.toBe(first)
    await expect(duplicate).resolves.toBe(false)
    queue.accept(queue.getSnapshot()!.id)
    await expect(first).resolves.toBe(true)
    const later = queue.confirm({ title: 'delete', operationKey: 'note:1:delete' })
    expect(queue.getSnapshot()?.title).toBe('delete')
    queue.cancel(queue.getSnapshot()!.id)
    await expect(later).resolves.toBe(false)
  })

  it('rejects duplicate prompts as null without sharing the approved text', async () => {
    const queue = createConfirmQueue()
    const first = queue.prompt({ title: 'rename', operationKey: 'category:1:rename' })
    const duplicate = queue.prompt({ title: 'rename', operationKey: 'category:1:rename' })
    await expect(duplicate).resolves.toBeNull()
    queue.accept(queue.getSnapshot()!.id, ' first writer ')
    await expect(first).resolves.toBe('first writer')
  })

  it('does not approve or dismiss an empty prompt and trims an accepted value', async () => {
    const queue = createConfirmQueue()
    const result = queue.prompt({ title: 'rename' })
    const id = queue.getSnapshot()!.id
    expect(queue.accept(id, ' \n ')).toBe(false)
    expect(queue.getSnapshot()?.id).toBe(id)
    expect(queue.accept(id, '  new name  ')).toBe(true)
    await expect(result).resolves.toBe('new name')
  })

  it('immediately cancels an already aborted owner without putting it in the queue', async () => {
    const queue = createConfirmQueue()
    const controller = new AbortController()
    controller.abort()
    await expect(queue.confirm({ title: 'stale', signal: controller.signal })).resolves.toBe(false)
    await expect(queue.prompt({ title: 'stale', signal: controller.signal })).resolves.toBeNull()
    expect(queue.getSnapshot()).toBeNull()
  })

  it('cancels active and waiting owners independently while preserving the remaining FIFO request', async () => {
    const queue = createConfirmQueue()
    const activeOwner = new AbortController()
    const waitingOwner = new AbortController()
    const first = queue.confirm({ title: 'active', signal: activeOwner.signal })
    const second = queue.prompt({ title: 'waiting', signal: waitingOwner.signal })
    const third = queue.confirm({ title: 'remaining' })
    waitingOwner.abort()
    await expect(second).resolves.toBeNull()
    expect(queue.getSnapshot()?.title).toBe('active')
    activeOwner.abort()
    await expect(first).resolves.toBe(false)
    expect(queue.getSnapshot()?.title).toBe('remaining')
    queue.accept(queue.getSnapshot()!.id)
    await expect(third).resolves.toBe(true)
  })

  it('removes each abort listener after approval, cancellation, and host disposal', async () => {
    const queue = createConfirmQueue()
    const detach = queue.attachHost()
    const controllers = [new AbortController(), new AbortController(), new AbortController()]
    const removals = controllers.map((controller) => vi.spyOn(controller.signal, 'removeEventListener'))
    const first = queue.confirm({ title: 'first', signal: controllers[0].signal })
    const second = queue.confirm({ title: 'second', signal: controllers[1].signal })
    const third = queue.prompt({ title: 'third', signal: controllers[2].signal })
    queue.accept(queue.getSnapshot()!.id)
    queue.cancel(queue.getSnapshot()!.id)
    detach()
    await Promise.resolve()
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(false)
    await expect(third).resolves.toBeNull()
    for (const removal of removals) expect(removal).toHaveBeenCalledTimes(1)
    expect(queue.getSnapshot()).toBeNull()
  })

  it('releases the originally registered owner listener even if the caller reuses its options object', async () => {
    const queue = createConfirmQueue()
    const original = new AbortController()
    const removal = vi.spyOn(original.signal, 'removeEventListener')
    const options = { title: 'first', signal: original.signal }
    const result = queue.confirm(options)
    options.signal = new AbortController().signal
    queue.accept(queue.getSnapshot()!.id)
    await expect(result).resolves.toBe(true)
    expect(removal).toHaveBeenCalledTimes(1)
  })

  it('safely settles every pending request when the host is actually removed', async () => {
    const queue = createConfirmQueue()
    const detach = queue.attachHost()
    const first = queue.confirm({ title: 'first', operationKey: 'host-unmount' })
    const second = queue.prompt({ title: 'second' })
    detach()
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBeNull()
    expect(queue.getSnapshot()).toBeNull()
  })

  it('keeps requests from the current StrictMode host when effect cleanup is immediately reattached', async () => {
    const queue = createConfirmQueue()
    const detachFirstEffect = queue.attachHost()
    const first = queue.confirm({ title: 'before effect replay' })
    detachFirstEffect()
    const detachCurrentEffect = queue.attachHost()
    const second = queue.prompt({ title: 'after effect replay' })
    await Promise.resolve()
    expect(queue.getSnapshot()?.title).toBe('before effect replay')
    queue.accept(queue.getSnapshot()!.id)
    await expect(first).resolves.toBe(true)
    expect(queue.getSnapshot()?.title).toBe('after effect replay')
    detachCurrentEffect()
    await expect(second).resolves.toBeNull()
  })

  it('notifies subscribers when abort changes the displayed request and stops after unsubscribe', async () => {
    const queue = createConfirmQueue()
    const controller = new AbortController()
    const titles: unknown[] = []
    const unsubscribe = queue.subscribe(() => titles.push(queue.getSnapshot()?.title ?? null))
    const first = queue.confirm({ title: 'first', signal: controller.signal })
    const second = queue.confirm({ title: 'second' })
    controller.abort()
    await expect(first).resolves.toBe(false)
    expect(titles).toEqual(['first', 'second'])
    unsubscribe()
    queue.cancel(queue.getSnapshot()!.id)
    await expect(second).resolves.toBe(false)
    expect(titles).toEqual(['first', 'second'])
  })
})

describe('confirmation owner scope', () => {
  it('does not abort a signal during immediate StrictMode effect replay', async () => {
    const scope = createDialogScope()
    const cleanupFirst = scope.attach()
    cleanupFirst()
    const cleanupCurrent = scope.attach()
    await Promise.resolve()
    expect(scope.signal.aborted).toBe(false)
    cleanupCurrent()
    await Promise.resolve()
    expect(scope.signal.aborted).toBe(true)
  })

  it('aborts an old scope without cancelling the newly mounted entity scope', async () => {
    const oldScope = createDialogScope()
    const cleanupOld = oldScope.attach()
    const newScope = createDialogScope()
    const cleanupNew = newScope.attach()
    cleanupOld()
    await Promise.resolve()
    expect(oldScope.signal.aborted).toBe(true)
    expect(newScope.signal.aborted).toBe(false)
    cleanupNew()
  })
})

describe('prompt mutation recovery', () => {
  it('retains a failed request and allows an explicit retry before settling its promise', async () => {
    const queue = createConfirmQueue()
    let attempts = 0
    const result = queue.prompt({
      title: 'rename',
      defaultValue: 'original',
      submit: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('write unavailable')
      }
    })
    let settled = false
    void result.then(() => {
      settled = true
    })
    const id = queue.getSnapshot()!.id
    expect(queue.accept(id, ' edited ')).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(queue.getSnapshot()).toMatchObject({ id, submitting: false, error: new Error('write unavailable') })
    queue.accept(id, ' edited ')
    await expect(result).resolves.toBe('edited')
    expect(attempts).toBe(2)
  })

  it('does not submit a second mutation while the first attempt is in flight', async () => {
    const queue = createConfirmQueue()
    const mutation = deferred<void>()
    let attempts = 0
    const result = queue.prompt({
      title: 'rename',
      submit: () => {
        attempts += 1
        return mutation.promise
      }
    })
    const id = queue.getSnapshot()!.id
    expect(queue.accept(id, 'edited')).toBe(true)
    expect(queue.getSnapshot()).toMatchObject({ submitting: true })
    expect(queue.accept(id, 'edited again')).toBe(false)
    expect(attempts).toBe(1)
    mutation.resolve()
    await expect(result).resolves.toBe('edited')
  })

  it('waits for an authorized write to settle after abort and keeps its operation key occupied meanwhile', async () => {
    const queue = createConfirmQueue()
    const owner = new AbortController()
    const mutation = deferred<void>()
    let writes = 0
    const result = queue.prompt({ title: 'rename', operationKey: 'running:rename', signal: owner.signal, submit: async () => { await mutation.promise; writes += 1 } })
    let settled = false
    void result.then(() => {
      settled = true
    })
    queue.accept(queue.getSnapshot()!.id, 'written value')
    owner.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(queue.getSnapshot()).toBeNull()
    await expect(queue.prompt({ title: 'duplicate', operationKey: 'running:rename' })).resolves.toBeNull()
    mutation.resolve()
    await expect(result).resolves.toBeNull()
    expect(writes).toBe(1)
  })

  it('cancels queued requests on host disposal but waits for the already started write', async () => {
    const queue = createConfirmQueue()
    const detach = queue.attachHost()
    const mutation = deferred<void>()
    const first = queue.prompt({ title: 'running', submit: () => mutation.promise })
    let settled = false
    void first.then(() => {
      settled = true
    })
    const second = queue.confirm({ title: 'waiting' })
    queue.accept(queue.getSnapshot()!.id, 'written')
    detach()
    await expect(second).resolves.toBe(false)
    expect(settled).toBe(false)
    expect(queue.getSnapshot()).toBeNull()
    mutation.resolve()
    await expect(first).resolves.toBeNull()
  })

  it('does not reopen a failed mutation dialog for an owner that has already disappeared', async () => {
    const queue = createConfirmQueue()
    const owner = new AbortController()
    const mutation = deferred<void>()
    const result = queue.prompt({ title: 'running', signal: owner.signal, submit: () => mutation.promise })
    queue.accept(queue.getSnapshot()!.id, 'written')
    owner.abort()
    mutation.reject(new Error('write unavailable'))
    await expect(result).resolves.toBeNull()
    expect(queue.getSnapshot()).toBeNull()
  })
})

describe('confirmed action lock', () => {
  it('prevents a bulk and a single-entity writer from mutating the same entity concurrently', async () => {
    const mutation = deferred<void>()
    const bulk = withActionLock(['note:bulk-a:delete', 'note:bulk-b:delete'], () => mutation.promise)
    let extraWrites = 0
    await expect(
      withActionLock('note:bulk-b:delete', () => {
        extraWrites += 1
      })
    ).resolves.toBe(false)
    expect(extraWrites).toBe(0)
    mutation.resolve()
    await expect(bulk).resolves.toBe(true)
    await expect(
      withActionLock('note:bulk-b:delete', () => {
        extraWrites += 1
      })
    ).resolves.toBe(true)
    expect(extraWrites).toBe(1)
  })

  it('holds the same entity action lock through confirmation and the actual asynchronous mutation', async () => {
    const queue = createConfirmQueue()
    const mutation = deferred<void>()
    let writes = 0
    const run = () =>
      withActionLock('note:locked:delete', async () => {
        if (!(await queue.confirm({ title: 'delete', operationKey: 'note:locked:delete' }))) return
        writes += 1
        await mutation.promise
      })
    const first = run()
    await expect(run()).resolves.toBe(false)
    expect(writes).toBe(0)
    queue.accept(queue.getSnapshot()!.id)
    await Promise.resolve()
    expect(writes).toBe(1)
    await expect(run()).resolves.toBe(false)
    expect(queue.getSnapshot()).toBeNull()
    mutation.resolve()
    await expect(first).resolves.toBe(true)
    const next = run()
    queue.cancel(queue.getSnapshot()!.id)
    await expect(next).resolves.toBe(true)
    expect(writes).toBe(1)
  })

  it('propagates a failed action and releases its lock so a later attempt can recover', async () => {
    const failure = new Error('write failed')
    await expect(
      withActionLock('failure:retry', () => {
        throw failure
      })
    ).rejects.toBe(failure)
    let recovered = false
    await expect(
      withActionLock('failure:retry', () => {
        recovered = true
      })
    ).resolves.toBe(true)
    expect(recovered).toBe(true)
  })

  it('does not start an action whose owner was already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    let writes = 0
    await expect(
      withActionLock(
        'aborted:before',
        () => {
          writes += 1
        },
        { signal: controller.signal }
      )
    ).resolves.toBe(false)
    expect(writes).toBe(0)
  })

  it('does not release an in-flight mutation lock early when its owner aborts', async () => {
    const controller = new AbortController()
    const mutation = deferred<void>()
    const first = withActionLock('aborted:during', () => mutation.promise, { signal: controller.signal })
    controller.abort()
    let extraWrites = 0
    await expect(
      withActionLock('aborted:during', () => {
        extraWrites += 1
      })
    ).resolves.toBe(false)
    expect(extraWrites).toBe(0)
    mutation.resolve()
    await expect(first).resolves.toBe(true)
  })
})
