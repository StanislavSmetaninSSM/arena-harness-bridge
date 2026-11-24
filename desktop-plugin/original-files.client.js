/* Desktop loads browser plugins as module factories. The host entry remains Node-only. */
window.__ModuleLoader__.load({
  id: 'dsh-arena-desktop',
  factory(require) {
    const React = require('react')
    const documents = new WeakMap()

    function composerInput(card) {
      return card.querySelector('input[type="file"][multiple][hidden]')
    }

    function receive(document, seats) {
      const view = document.defaultView
      const cardOf = node => node?.closest?.('[data-composer-card]')
      const editable = 'input,textarea,select,[contenteditable]:not([contenteditable="false"])'
      const modals = '[role="dialog"][aria-modal="true"],[data-menu-popup],[role="menu"]'
      let lastFocused

      // A synthetic File is browser-owned: Electron has no filesystem path
      // for it. The generic media type selects Harness's verbatim File store.
      // File wraps the existing Blob, retaining its bytes, name and order.
      function originals(files) {
        const result = new view.DataTransfer()
        for (const file of files) {
          let name = file.name, parts = [file]
          // The native store normalizes some valid Windows names. Store that
          // name with this one File so it survives drafts, retries and restart.
          if (!namePreserved(name) || /^arena-file-[0-9a-f-]{36}-[0-9]+\.bin$/i.test(name)) {
            const id = view.crypto.randomUUID()
            const header = new TextEncoder().encode(JSON.stringify({id,name,mediaType:file.type}))
            name = 'arena-file-'+id+'-'+header.length+'.bin'
            parts = [header,file]
          }
          result.items.add(new view.File(parts,name,
            {type:'application/octet-stream',lastModified:file.lastModified}))
        }
        return result.files
      }

      function available(card) {
        return card?.isConnected && !card.closest('[inert],[hidden]') && composerInput(card)?.disabled === false
      }

      function focus(event) {
        const card = cardOf(event.target)
        if (card) lastFocused = card
      }

      function namePreserved(name) {
        // Native fileLeafName sanitizes these cases before the provider sees a ref.
        const stem = name.split('.')[0].replace(/[. ]+$/u,'')
        return name && name === name.trim() && !/[.]$/u.test(name) &&
          !/[\u0000-\u001f\u007f<>:"|?*\/\\]/u.test(name) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(stem) &&
          new TextEncoder().encode(name).length <= 255
      }

      function picker(event) {
        const input = event.target
        const card = cardOf(input)
        const seat = seats.get(card)
        if (!seat?.isArena() || !available(card) || input !== composerInput(card) || !input.files.length) return
        seat.report('')
        input.files = originals(input.files)
      }

      function finish(event) {
        event.preventDefault()
        event.stopImmediatePropagation()
        // Harness's document-level drop listener also clears each attachment
        // overlay. An external OS drag never delivers dragend inside the app.
        if (event.type === 'drop') view.dispatchEvent(new view.Event('dragend'))
      }

      function destination(event, target, foreground) {
        const candidates = [...document.querySelectorAll('[data-composer-card]')].filter(card =>
          available(card) && (!foreground || foreground.contains(card)))
        if (event.type === 'paste' && target?.closest(editable) && !target.closest('[data-composer-input]')) return
        const direct = cardOf(target)
        if (direct) return candidates.includes(direct) ? direct : undefined
        if (event.type === 'drop') {
          const chat = target?.closest('[data-conversation-content]')
          const sameChat = candidates.filter(card => chat && card.closest('[data-conversation-content]') === chat)
          if (sameChat.length === 1) return sameChat[0]
        }
        if (candidates.includes(lastFocused)) return lastFocused
        const main = document.querySelector('[data-slot="main.conversation"] [data-conversation-content]')
        return candidates.find(card => main && card.closest('[data-conversation-content]') === main)
      }

      function transfer(event) {
        const data = event.clipboardData || event.dataTransfer
        if (!data || event.defaultPrevented) return
        const items = [...data.items].filter(item => item.kind === 'file')
        const files = items.length ? items.map(item=>item.getAsFile()).filter(Boolean) : [...data.files]
        if (!files.length) return
        const target = event.composedPath().find(node => node?.nodeType === 1)
        const foreground = [...document.querySelectorAll(modals)].at(-1)
        const card = destination(event,target,foreground)
        const seat = seats.get(card)
        if (!seat?.isArena()) {
          if (event.type !== 'drop' || ![...seats].some(([el,owner])=>available(el) && owner.isArena())) return
          if (card) {
            // A native drop broadcasts to every mounted attachment view. Its
            // editor paste route addresses exactly one composer and passes
            // the original DataTransferItems (including OS directory entries)
            // to the very same intake. Drag labels are not text to insert.
            const editor = card.querySelector('[data-composer-input]')
            finish(event)
            if (editor) {
              const paste = new view.ClipboardEvent('paste',{bubbles:true,cancelable:true})
              Object.defineProperty(paste,'clipboardData',{value:{items,files:data.files,getData:()=>''}})
              editor.dispatchEvent(paste)
            }
          } else if (foreground) {
            // Let a foreground dialog's own control see its drop. The native
            // document listeners behind it accept drops even when obscured.
            if (foreground.contains(target)) {
              const stop = delivered => { if (delivered === event) finish(event) }
              foreground.addEventListener('drop',stop,{once:true})
              queueMicrotask(()=>foreground.removeEventListener('drop',stop))
            } else finish(event)
          }
          return
        }
        finish(event)
        if (items.some(item => item.webkitGetAsEntry?.()?.isDirectory)) {
          seat.report('Select the files inside the folder and attach them together. The batch was not added.')
          return
        }
        const input = composerInput(card)
        const picked = new view.DataTransfer()
        for (const file of files) picked.items.add(file)
        input.files = picked.files
        input.dispatchEvent(new view.Event('change',{bubbles:true}))
      }

      view.addEventListener('change',picker,true)
      view.addEventListener('focusin',focus,true)
      view.addEventListener('paste',transfer,true)
      view.addEventListener('drop',transfer,true)
      return () => {
        view.removeEventListener('change',picker,true)
        view.removeEventListener('focusin',focus,true)
        view.removeEventListener('paste',transfer,true)
        view.removeEventListener('drop',transfer,true)
      }
    }

    function seat(element, isArena) {
      const document = element.ownerDocument
      const card = element.closest('[data-composer-card]')
      if (!card) return
      let entry = documents.get(document)
      if (!entry) {
        const seats = new Map()
        entry = {seats,dispose:receive(document,seats)}
        documents.set(document,entry)
      }
      const registration = {isArena, report(message) {
        element.textContent = message
        element.hidden = !message
      }}
      entry.seats.set(card,registration)
      return () => {
        if (entry.seats.get(card) === registration) entry.seats.delete(card)
        if (!entry.seats.size) {
          entry.dispose()
          documents.delete(document)
        }
      }
    }

    function AttachmentIntake({isArena}) {
      const ref = React.useRef(null)
      React.useLayoutEffect(()=>ref.current && seat(ref.current,isArena),[isArena])
      return React.createElement('span',{hidden:true,role:'alert',ref})
    }

    return {
      inject:['slots','modelDirectories'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
          name:'conversation.input.overlay', id:'arena-original-file-intake',
          inject(sessionId) {
            const directory = ctx.modelDirectories.directoryFor(sessionId)
            return {isArena:() => {
              const model = directory.store.getSnapshot().current
              return model?.provider === 'arena' && model.model === 'agent-mode'
            }}
          },
        },AttachmentIntake))
      },
    }
  },
})
