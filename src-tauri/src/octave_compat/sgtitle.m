function h = sgtitle(txt)
  % BridgeDeck fill-in for MATLAB's sgtitle: a title over all the subplots.
  h = annotation('textbox', [0 0.95 1 0.05], 'String', txt, 'EdgeColor', 'none', 'FitBoxToText', 'off', ...
    'HorizontalAlignment', 'center', 'FontWeight', 'bold', 'FontSize', 12);
end
