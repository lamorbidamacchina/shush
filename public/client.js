const socket = io();
const ec = new elliptic.ec('secp256k1');

// Generate client keys
const keyPair = ec.genKeyPair();
const myPublicKey = keyPair.getPublic('hex');
const myPrivateKey = keyPair.getPrivate('hex');

// Map to store other users' public keys
const userKeys = new Map();

// Add this global variable at the top of the file
let connectedUsers = new Map();
const unreadMessages = new Map();
let activeConversationWith = null;

// Connection established
socket.on('connect', () => {
    console.log('Connected to server with ID:', socket.id);
    socket.emit('register', myPublicKey);
});

// Users list update
socket.on('users-update', (users) => {
    // Update our local copy of connected users
    connectedUsers = new Map(users.map(user => [user.socketId, user]));
    updateUsersList(users);
    updateRecipientSelect(users);
});

// Message reception
socket.on('private-message', async ({ from, fromName, encryptedMessage }) => {
    try {
        const decryptedMessage = await decryptMessage(encryptedMessage);
        
        // Add received message to history
        addMessageToHistory({
            from: from,
            to: socket.id,
            sender: fromName,
            text: decryptedMessage
        });

        // If this message is not from the active conversation, increment unread count
        if (from !== activeConversationWith) {
            const currentCount = unreadMessages.get(from) || 0;
            unreadMessages.set(from, currentCount + 1);
            updateUsersList(Array.from(connectedUsers.values()));
        }
    } catch (error) {
        console.error('Decryption error:', error);
        displayError('Error decrypting message');
    }
});

// UI Functions
function updateUsersList(users) {
    const usersList = document.getElementById('users-list');
    usersList.innerHTML = '';
    
    // Find current user
    const currentUser = users.find(user => user.socketId === socket.id);
    
    // Add current user first
    if (currentUser) {
        const userElement = document.createElement('div');
        userElement.className = 'user-item current-user';
        userElement.textContent = `You: ${currentUser.displayName}`;
        usersList.appendChild(userElement);
    }
    
    // Add other users
    users.forEach(user => {
        if (user.socketId !== socket.id) {
            userKeys.set(user.socketId, user.publicKey);
            
            const userElement = document.createElement('div');
            userElement.className = `user-item clickable ${user.socketId === activeConversationWith ? 'active' : ''}`;
            
            // Create user name container
            const nameContainer = document.createElement('div');
            nameContainer.className = 'user-item-content';
            nameContainer.textContent = `User: ${user.displayName}`;
            
            // Add unread messages badge if any
            const unreadCount = unreadMessages.get(user.socketId) || 0;
            if (unreadCount > 0 && user.socketId !== activeConversationWith) {
                const badge = document.createElement('span');
                badge.className = 'unread-badge';
                badge.textContent = unreadCount;
                nameContainer.appendChild(badge);
            }
            
            userElement.appendChild(nameContainer);
            
            // Add click handler
            userElement.addEventListener('click', () => {
                // Clear unread messages for this user
                unreadMessages.delete(user.socketId);
                
                // Update active conversation
                activeConversationWith = user.socketId;
                
                // Update UI
                document.querySelectorAll('.user-item').forEach(el => el.classList.remove('active'));
                userElement.classList.add('active');
                
                // Update recipient select
                const recipientSelect = document.getElementById('recipient-select');
                recipientSelect.value = user.socketId;
                
                // Update message display
                filterMessages(user.socketId);
                
                // Remove badge immediately
                const badge = userElement.querySelector('.unread-badge');
                if (badge) {
                    badge.remove();
                }
                
                // Focus message input
                document.getElementById('message-input').focus();

                // Add this for mobile
                if (window.innerWidth <= 768) {
                    backToChat();
                }
            });
            
            usersList.appendChild(userElement);
        }
    });
}

function updateRecipientSelect(users) {
    const select = document.getElementById('recipient-select');
    select.value = '';
}

function displayMessage(sender, message) {
    const messageList = document.getElementById('message-list');
    const messageElement = document.createElement('div');
    messageElement.className = `message ${sender === 'You' ? 'sent' : 'received'}`;
    messageElement.textContent = `${sender}: ${message}`;
    messageList.appendChild(messageElement);
    messageList.scrollTop = messageList.scrollHeight;
}

function displayError(message) {
    const errorElement = document.createElement('div');
    errorElement.className = 'error-message';
    errorElement.textContent = message;
    document.getElementById('message-list').appendChild(errorElement);
}

// Send message function
async function sendMessage() {
    const messageInput = document.getElementById('message-input');
    const message = messageInput.value;
    
    if (!activeConversationWith || !message) {
        displayError('Please select a user to chat with and type a message');
        return;
    }
    
    try {
        const recipientPublicKey = userKeys.get(activeConversationWith);
        const encryptedMessage = await encryptMessage(message, recipientPublicKey);
        
        socket.emit('private-message', {
            to: activeConversationWith,
            encryptedMessage: encryptedMessage,
            fromName: 'You'
        });
        
        // Add message to history
        addMessageToHistory({
            from: socket.id,
            to: activeConversationWith,
            sender: 'You',
            text: message
        });
        
        // Clear input
        messageInput.value = '';
    } catch (error) {
        console.error('Error sending message:', error);
        displayError('Error sending message');
    }
}

// Encryption/decryption functions
async function encryptMessage(message, publicKeyHex) {
  try {
      // Convert public key of the recipient from hex
      const publicKey = ec.keyFromPublic(publicKeyHex, 'hex');
      
      // Generate ephemeral key pair for this message
      const ephemeral = ec.genKeyPair();
      
      // Calculate shared secret
      const sharedSecret = ephemeral.derive(publicKey.getPublic());
      
      // Use shared secret to create an AES key
      const sharedSecretHex = sharedSecret.toString('hex');
      
      // Convert message to bytes
      const msgBytes = new TextEncoder().encode(message);
      
      // Use SubtleCrypto for AES encryption
      const key = await crypto.subtle.importKey(
          'raw',
          hexToUint8Array(sharedSecretHex.slice(0, 32)),
          { name: 'AES-GCM' },
          false,
          ['encrypt']
      );
      
      // Generate random IV
      const iv = crypto.getRandomValues(new Uint8Array(12));
      
      // Encrypt message
      const encryptedData = await crypto.subtle.encrypt(
          {
              name: 'AES-GCM',
              iv: iv
          },
          key,
          msgBytes
      );
      
      // Combine data necessary for decryption
      return {
          ephemeralPublicKey: ephemeral.getPublic('hex'),
          iv: Array.from(iv),
          encryptedData: Array.from(new Uint8Array(encryptedData))
      };
  } catch (error) {
      console.error('Encryption error:', error);
      throw error;
  }
}

async function decryptMessage(encryptedMessage) {
  try {
      // Extract components from message
      const { ephemeralPublicKey, iv, encryptedData } = encryptedMessage;
      
      // Reconstruct ephemeral public key
      const ephemeralKey = ec.keyFromPublic(ephemeralPublicKey, 'hex');
      
      // Use your private key to derive the same shared secret
      const privateKey = ec.keyFromPrivate(myPrivateKey, 'hex');
      const sharedSecret = privateKey.derive(ephemeralKey.getPublic());
      
      // Use shared secret to create an AES key
      const sharedSecretHex = sharedSecret.toString('hex');
      
      // Import key for AES
      const key = await crypto.subtle.importKey(
          'raw',
          hexToUint8Array(sharedSecretHex.slice(0, 32)),
          { name: 'AES-GCM' },
          false,
          ['decrypt']
      );
      
      // Decrypt message
      const decryptedData = await crypto.subtle.decrypt(
          {
              name: 'AES-GCM',
              iv: new Uint8Array(iv)
          },
          key,
          new Uint8Array(encryptedData)
      );
      
      // Convert result to string
      return new TextDecoder().decode(decryptedData);
  } catch (error) {
      console.error('Decryption error:', error);
      throw error;
  }
}

// Utility functions
function hexToUint8Array(hexString) {
  const bytes = new Uint8Array(hexString.length / 2);
  for (let i = 0; i < hexString.length; i += 2) {
      bytes[i / 2] = parseInt(hexString.substr(i, 2), 16);
  }
  return bytes;
}

// Modifica la struttura dei messaggi per includere informazioni sul mittente e destinatario
const messageHistory = [];

function addMessageToHistory(message) {
    messageHistory.push(message);
    if (message.to === activeConversationWith || message.from === activeConversationWith) {
        displayMessage(message.sender, message.text);
    }
}

function filterMessages(userId) {
    // Clear current messages
    const messageList = document.getElementById('message-list');
    messageList.innerHTML = '';
    
    // Filter and display only messages between current user and selected user
    messageHistory
        .filter(msg => (msg.to === userId || msg.from === userId))
        .forEach(msg => displayMessage(msg.sender, msg.text));
}

// Add this after all the other initialization code
document.getElementById('message-input').addEventListener('keypress', function(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault(); // Prevent default to avoid newline
        sendMessage();
    }
});

// Add these functions for modal control
function openAboutModal() {
    document.getElementById('about-modal').style.display = 'block';
    // Optional: prevent body scroll when modal is open
    document.body.style.overflow = 'hidden';
}

function closeAboutModal() {
    document.getElementById('about-modal').style.display = 'none';
    // Optional: restore body scroll
    document.body.style.overflow = 'auto';
}

// Optional: Close modal when clicking outside
window.onclick = function(event) {
    const modal = document.getElementById('about-modal');
    if (event.target === modal) {
        closeAboutModal();
    }
}

// Add these functions for mobile navigation
function toggleUsersList() {
    const usersPanel = document.querySelector('.users-panel');
    usersPanel.classList.add('active');
}

function backToChat() {
    const usersPanel = document.querySelector('.users-panel');
    usersPanel.classList.remove('active');
}

// Optional: Handle resize events
window.addEventListener('resize', () => {
    const usersPanel = document.querySelector('.users-panel');
    if (window.innerWidth > 768) {
        usersPanel.classList.remove('active');
    }
});