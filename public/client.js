const serverUrl = window.location.hostname === 'localhost' 
  ? 'http://localhost:3000'  // local dev URL 
  : 'https://shush.fly.dev'; // production URL

const socket = io(serverUrl, {
  transports: ['websocket', 'polling'],
  reconnectionAttempts: 5
});
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
let isViewingUsersList = window.innerWidth <= 768;  // Initialize based on screen width

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

        // Increment unread messages counter only if:
        // 1. User is viewing the users list, OR
        // 2. Message is from someone other than active conversation
        if (isViewingUsersList || from !== activeConversationWith) {
            const currentCount = unreadMessages.get(from) || 0;
            unreadMessages.set(from, currentCount + 1);
            // Force UI update
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
            
            // Add username
            const nameSpan = document.createElement('span');
            nameSpan.textContent = user.displayName;
            nameContainer.appendChild(nameSpan);
            
            // Add unread messages badge
            const unreadCount = unreadMessages.get(user.socketId) || 0;
            if (unreadCount > 0) {
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
                isViewingUsersList = false;  // Explicitly set to false when starting a chat
                
                // Update UI
                document.querySelectorAll('.user-item').forEach(el => el.classList.remove('active'));
                userElement.classList.add('active');
                
                // Update recipient select
                const recipientSelect = document.getElementById('recipient-select');
                recipientSelect.value = user.socketId;
                
                // Update message display
                filterMessages(user.socketId);
                
                // Focus message input
                document.getElementById('message-input').focus();

                // Handle mobile view
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
    isViewingUsersList = true;
    activeConversationWith = null;
    // Force UI update
    updateUsersList(Array.from(connectedUsers.values()));
}

function backToChat() {
    const usersPanel = document.querySelector('.users-panel');
    usersPanel.classList.remove('active');
    isViewingUsersList = false;
    // Force UI update
    updateUsersList(Array.from(connectedUsers.values()));
}

// Optional: Handle resize events
window.addEventListener('resize', () => {
    const usersPanel = document.querySelector('.users-panel');
    if (window.innerWidth > 768) {
        usersPanel.classList.remove('active');
        isViewingUsersList = false;
    } else {
        // On mobile, if no active conversation, show users list
        isViewingUsersList = !activeConversationWith;
    }
    // Force UI update
    updateUsersList(Array.from(connectedUsers.values()));
});

// Add key rotation functionality
const KEY_ROTATION_INTERVAL = 1000 * 60 * 60; // 1 hour

function rotateKeys() {
    // Generate new keypair
    const newKeyPair = nacl.box.keyPair();
    
    // Store old keys temporarily for message decryption
    const oldPrivateKey = myPrivateKey;
    const oldPublicKey = myPublicKey;
    
    // Update current keys
    myPrivateKey = newKeyPair.secretKey;
    myPublicKey = nacl.util.encodeBase64(newKeyPair.publicKey);
    
    // Notify server of new public key
    socket.emit('update-key', myPublicKey);
    
    // Keep old keys for a grace period to decrypt pending messages
    setTimeout(() => {
        // Securely clear old keys from memory
        oldPrivateKey.fill(0);
        oldPublicKey.fill(0);
    }, 1000 * 60 * 5); // 5 minutes grace period
}

// Start key rotation
setInterval(rotateKeys, KEY_ROTATION_INTERVAL);