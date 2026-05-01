// public/script.js

let currentFilterConfig = {}; // ← This will hold your current filter settings

// DOM Elements
const saveModal = document.getElementById('saveModal');
const overwriteModal = document.getElementById('overwriteModal');
const existingSelect = document.getElementById('existingFilters');
const newNameInput = document.getElementById('newFilterName');
const overwriteNameDisplay = document.getElementById('overwriteName');

// Open Save Modal when user clicks Save button
document.getElementById('saveFilterBtn').addEventListener('click', async () => {
    try {
        const response = await fetch('/api/filters');
        const filters = await response.json();

        // Populate dropdown
        existingSelect.innerHTML = '<option value="">— Save as New Filter —</option>';
        
        filters.forEach(filter => {
            const option = document.createElement('option');
            option.value = filter.name;
            option.textContent = filter.name;
            existingSelect.appendChild(option);
        });

        // Reset form
        newNameInput.value = '';
        existingSelect.value = '';
        saveModal.classList.remove('hidden');

    } catch (err) {
        alert('Could not load saved filters');
        console.error(err);
    }
});

// Handle selection of existing filter
existingSelect.addEventListener('change', () => {
    if (existingSelect.value) {
        newNameInput.parentElement.style.display = 'none';
    } else {
        newNameInput.parentElement.style.display = 'block';
    }
});

// Confirm Save button
document.getElementById('confirmSave').addEventListener('click', async () => {
    const selectedName = existingSelect.value;
    const newName = newNameInput.value.trim();

    const finalName = selectedName || newName;

    if (!finalName) {
        alert("Please enter a filter name or select an existing one.");
        return;
    }

    if (selectedName) {
        // Show overwrite confirmation
        overwriteNameDisplay.textContent = selectedName;
        overwriteModal.classList.remove('hidden');
    } else {
        // Save as new
        await saveFilterToServer(finalName, false);
    }
});

// Overwrite Yes button
document.getElementById('yesOverwrite').addEventListener('click', async () => {
    const name = existingSelect.value;
    await saveFilterToServer(name, true);
    overwriteModal.classList.add('hidden');
    saveModal.classList.add('hidden');
});

// Overwrite Cancel
document.getElementById('noOverwrite').addEventListener('click', () => {
    overwriteModal.classList.add('hidden');
});

// Cancel main modal
document.getElementById('cancelSave').addEventListener('click', () => {
    saveModal.classList.add('hidden');
});

// Main function to save to backend
async function saveFilterToServer(name, overwrite) {
    try {
        const response = await fetch('/api/filters/save', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: name,
                config: currentFilterConfig,   // ← Your filter data goes here
                overwrite: overwrite
            })
        });

        const result = await response.json();

        if (response.ok) {
            const message = overwrite 
                ? `Filter "${name}" has been overwritten successfully!` 
                : `Filter "${name}" saved successfully!`;
            
            alert(message);
            saveModal.classList.add('hidden');
        } else {
            alert(result.error || 'Failed to save filter');
        }
    } catch (err) {
        console.error(err);
        alert('Error saving filter. Please try again.');
    }
}
